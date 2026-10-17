import { isRecord, readBodyBytes } from "../../http";
import { MODEL_PROVIDERS } from "../modelCatalogue";
import type { CatalogueModel } from "../modelCatalogue";
import { ModelProviderError } from "../provider";
import { CREDENTIAL_PATTERN } from "./config";
import type { TkslopperClientConfig, TkslopperOperation, TkslopperTarget } from "./config";

const GRANT_TTL_SECONDS = 900;
const GRANT_REFRESH_MARGIN_MS = 60_000;
const EXCHANGE_TIMEOUT_MS = 5_000;
// A shared exchange older than its own abort is replaced, and each waiter
// allows it a further second, so a late joiner always waits at least that.
const EXCHANGE_WAIT_MS = EXCHANGE_TIMEOUT_MS + 1_000;
// A cached grant still this far from expiry covers a failed refresh.
const STALE_GRANT_MARGIN_MS = 5_000;
// After a transient refresh failure, keep the covering grant this long
// before trying the control plane again.
const REFRESH_BACKOFF_MS = 10_000;
const GATEWAY_TIMEOUT_MS = 45_000;
const INTERNAL_ORIGIN = "https://tkslopper.internal";

interface Grant {
  accessToken: string;
  expiresAt: number;
  refreshAt: number;
}

interface PendingExchange {
  promise: Promise<Grant>;
  startedAt: number;
}

interface GrantSlot {
  grant?: Grant;
  pending?: PendingExchange;
  retryAfter?: number;
}

/**
 * Per-isolate grant cache. Every exchange costs the control plane a PBKDF2
 * verification and a D1 write, so grants are reused until a minute before
 * expiry and concurrent requests share one in-flight exchange.
 */
export class TkslopperGrantCache {
  private readonly slots = new Map<string, GrantSlot>();

  slot(key: string): GrantSlot {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = {};
      this.slots.set(key, slot);
    }
    return slot;
  }
}

const sharedGrantCache = new TkslopperGrantCache();

/** Error from the tkslopper transport, with the gateway request id if known. */
export class TkslopperError extends ModelProviderError {
  constructor(
    message: string,
    retryable: boolean,
    readonly status?: number,
    readonly gatewayRequestId?: string,
  ) {
    super(message, retryable);
  }
}

/**
 * The class's tkslopper access refused a request: its budget is spent
 * (`allowance`), or its key, class or group is unknown, revoked, paused or
 * outside its schedule (`unavailable`). Never retried or rerouted.
 */
export class ClassAccessError extends TkslopperError {
  constructor(
    readonly denial: "allowance" | "unavailable",
    status: number,
    gatewayRequestId?: string,
  ) {
    super(
      denial === "allowance"
        ? "Class AI allowance reached"
        : "Class AI access unavailable",
      false,
      status,
      gatewayRequestId,
    );
  }
}

export interface TkslopperGatewayResult {
  body: Record<string, unknown>;
  gatewayRequestId?: string;
}

export interface ManagedModelMetadata {
  id: string;
  display_name?: string;
  provider?: string;
  tier?: CatalogueModel["tier"];
}

export interface TkslopperClientOptions {
  fetch?: typeof fetch;
  grantCache?: TkslopperGrantCache;
  now?: () => number;
}

interface ErrorBody {
  error?: { message?: unknown; type?: unknown; code?: unknown };
  request_id?: unknown;
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Only fixed transport categories are safe to log, never error text. */
function failureDetail(error: unknown): string {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    ? error.name
    : "transport failure";
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError")
      return "timed out";
    return `failed (${error.name})`;
  }
  return "failed";
}

/** Bounds how long one request waits on a possibly shared exchange. */
function withDeadline(promise: Promise<Grant>, ms: number): Promise<Grant> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      console.error("tkslopper grant exchange wait timed out");
      reject(new TkslopperError("Model access grant timed out", true));
    }, Math.max(0, ms));
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export class TkslopperClient {
  private readonly fetcher: typeof fetch;
  private readonly cache: TkslopperGrantCache;
  private readonly now: () => number;
  private readonly capabilities: string[];
  private readonly cacheKey: string;
  // A class key is itself the Bearer credential: no exchange, cache or expiry.
  private readonly classGrant?: Grant;

  constructor(
    private readonly config: TkslopperClientConfig,
    options: TkslopperClientOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.cache = options.grantCache ?? sharedGrantCache;
    this.now = options.now ?? Date.now;
    this.capabilities = [
      ...new Set([config.artifactAlias, config.reviewAlias, config.imageAlias]),
    ];
    if ("groupKey" in config) {
      this.classGrant = {
        accessToken: config.groupKey,
        expiresAt: Number.POSITIVE_INFINITY,
        refreshAt: Number.POSITIVE_INFINITY,
      };
      this.cacheKey = "";
      return;
    }
    // Keyed on the credential id so the secret is not copied into the cache.
    this.cacheKey = JSON.stringify([
      "url" in config.controlPlane ? config.controlPlane.url : "service-binding",
      CREDENTIAL_PATTERN.exec(config.serviceCredential)?.[1] ?? "",
      this.capabilities,
    ]);
  }

  /**
   * Checks this credential against GET /v1/models within three seconds.
   * Returns the HTTP status (0 when unreachable) and, on success, which of
   * Tapplet's configured aliases the credential may use.
   */
  async probeAliases(): Promise<{ status: number; aliases: string[] }> {
    try {
      const grant = await this.grant();
      const response = await this.dispatch(this.config.gateway, "/v1/models", {
        method: "GET",
        headers: { authorization: `Bearer ${grant.accessToken}`, accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, aliases: [] };
      }
      const bytes = await readBodyBytes(response, 256_000);
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!isRecord(body) || !Array.isArray(body.data)) return { status: 0, aliases: [] };
      const listed = new Set(
        body.data.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : [])),
      );
      return {
        status: response.status,
        aliases: this.capabilities.filter((alias) => listed.has(alias)),
      };
    } catch {
      return { status: 0, aliases: [] };
    }
  }

  /** Optional, read-only labels. No listing cache and no effect on inference IDs. */
  async listModelMetadata(): Promise<ManagedModelMetadata[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Model metadata timed out"));
      }, 3_000);
    });
    try {
      return await Promise.race([
        (async () => {
          const grant = await this.grant();
          // A shared exchange can finish after this display read times out.
          controller.signal.throwIfAborted();
          const response = await this.dispatch(this.config.gateway, "/v1/models", {
            method: "GET",
            headers: { authorization: `Bearer ${grant.accessToken}`, accept: "application/json" },
            cache: "no-store",
            credentials: "omit",
            redirect: "manual",
            signal: controller.signal,
          });
          if (response.status === 401 || response.status === 403) this.invalidate(grant);
          if (!response.ok) {
            await response.body?.cancel();
            return [];
          }
          const bytes = await readBodyBytes(response, 256_000);
          const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (!isRecord(body) || body.object !== "list" || !Array.isArray(body.data) || body.data.length > 500)
            return [];
          const seen = new Set<string>();
          const models: ManagedModelMetadata[] = [];
          for (const item of body.data) {
            if (!isRecord(item) || typeof item.id !== "string" || !this.capabilities.includes(item.id)) continue;
            if (seen.has(item.id)) return [];
            seen.add(item.id);
            const metadata: ManagedModelMetadata = { id: item.id };
            if (typeof item.display_name === "string" && item.display_name.trim() &&
              item.display_name.length <= 200 && !/[\x00-\x1f\x7f]/.test(item.display_name))
              metadata.display_name = item.display_name;
            if (typeof item.provider === "string" && MODEL_PROVIDERS.has(item.provider)) metadata.provider = item.provider;
            if (item.tier === "economy" || item.tier === "balanced" || item.tier === "premium") metadata.tier = item.tier;
            models.push(metadata);
          }
          return models;
        })(),
        deadline,
      ]);
    } catch { return []; }
    finally { clearTimeout(timer); controller.abort(); }
  }

  /**
   * Sends one gateway request. The body is size-checked before any network
   * call; a 401 is the only failure that is retried, once, with a new grant
   * and a new idempotency key because it is rejected before dispatch.
   */
  async request(
    path: "/v1/responses" | "/v1/chat/completions",
    body: Readonly<Record<string, unknown>>,
    operation: TkslopperOperation,
  ): Promise<TkslopperGatewayResult> {
    const serialised = JSON.stringify(body);
    const bytes = new TextEncoder().encode(serialised).byteLength;
    if (bytes > this.config.maxRequestBytes)
      throw new TkslopperError(
        `Model request is ${bytes} bytes, above the ${this.config.maxRequestBytes} byte tkslopper limit`,
        false,
      );

    let grant = await this.grant();
    let response = await this.send(path, serialised, operation, grant);
    if (response.status === 401 && !this.classGrant) {
      this.invalidate(grant);
      const rejectedId = response.headers.get("x-tkslopper-request-id");
      console.error(
        `tkslopper ${operation} grant rejected${rejectedId ? ` (request ${rejectedId})` : ""}; re-exchanging once`,
      );
      await response.body?.cancel();
      grant = await this.grant();
      response = await this.send(path, serialised, operation, grant);
    }
    const gatewayRequestId =
      response.headers.get("x-tkslopper-request-id") ?? undefined;

    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        this.invalidate(grant);
      const error = (await response.json().catch(() => null)) as ErrorBody | null;
      const code =
        typeof error?.error?.code === "string" ? error.error.code : "unknown";
      const requestId =
        gatewayRequestId ??
        (typeof error?.request_id === "string" ? error.request_id : undefined);
      console.error(
        `tkslopper ${operation} failed: HTTP ${response.status} ${code}${requestId ? ` (request ${requestId})` : ""}`,
      );
      // Budget is 402; unknown, revoked, paused or out-of-schedule access is
      // 401 or 403. For a class key these describe the class, not the fleet.
      if (this.classGrant && [401, 402, 403].includes(response.status))
        throw new ClassAccessError(
          response.status === 402 ? "allowance" : "unavailable",
          response.status,
          requestId,
        );
      throw new TkslopperError(
        typeof error?.error?.message === "string"
          ? error.error.message
          : `HTTP ${response.status}`,
        retryableStatus(response.status),
        response.status,
        requestId,
      );
    }

    const parsed: unknown = await response.json().catch(() => undefined);
    if (!isRecord(parsed))
      throw new TkslopperError(
        "Malformed gateway response",
        true,
        response.status,
        gatewayRequestId,
      );
    return {
      body: parsed,
      ...(gatewayRequestId ? { gatewayRequestId } : {}),
    };
  }

  private async send(
    path: string,
    serialised: string,
    operation: TkslopperOperation,
    grant: Grant,
  ): Promise<Response> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": `tapplet:${operation}:${crypto.randomUUID()}`,
      },
      body: serialised,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    };
    try {
      return await this.dispatch(this.config.gateway, path, init);
    } catch (error) {
      // An aborted attempt may still have reached the provider and been
      // charged, so it is surfaced as retryable but never retried here.
      console.error(`tkslopper ${operation} request failed: ${failureDetail(error)}`);
      throw new TkslopperError(
        `Model request ${describeFailure(error)}`,
        true,
      );
    }
  }

  private dispatch(
    target: TkslopperTarget,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    // Service bindings route on the path only; the public URL keeps working
    // when no binding is configured.
    if ("binding" in target)
      return target.binding.fetch(new Request(`${INTERNAL_ORIGIN}${path}`, init));
    return this.fetcher(`${target.url}${path}`, init);
  }

  private async grant(): Promise<Grant> {
    if (this.classGrant) return this.classGrant;
    const slot = this.cache.slot(this.cacheKey);
    const current = slot.grant;
    if (current && this.now() < current.refreshAt) return current;
    if (
      current &&
      slot.retryAfter !== undefined &&
      this.now() < slot.retryAfter &&
      this.usable(current)
    )
      return current;
    let pending = slot.pending;
    // A shared exchange belongs to the request that started it; if that
    // request is cancelled its promise may never settle, so an exchange older
    // than its own timeout is replaced rather than awaited.
    if (!pending || this.now() - pending.startedAt >= EXCHANGE_TIMEOUT_MS) {
      const started: PendingExchange = {
        promise: this.exchange().then((grant) => {
          // A replaced exchange that settles late must not displace a newer
          // grant from its replacement.
          if (
            slot.pending === started ||
            !slot.grant ||
            grant.expiresAt > slot.grant.expiresAt
          )
            slot.grant = grant;
          delete slot.retryAfter;
          return grant;
        }),
        startedAt: this.now(),
      };
      slot.pending = started;
      const settle = () => {
        if (slot.pending === started) delete slot.pending;
      };
      started.promise.then(settle, settle);
      pending = started;
    }
    try {
      return await withDeadline(
        pending.promise,
        pending.startedAt + EXCHANGE_WAIT_MS - this.now(),
      );
    } catch (error) {
      // Another request may have cached a fresh grant while this one waited.
      const latest = slot.grant;
      if (latest && latest !== current && this.now() < latest.refreshAt)
        return latest;
      // A control-plane blip must not fail requests while the cached grant is
      // still valid. Rejected credentials and kill switches are not retryable
      // and still fail.
      if (
        error instanceof TkslopperError &&
        error.retryable &&
        current &&
        latest === current &&
        this.usable(current)
      ) {
        slot.retryAfter = this.now() + REFRESH_BACKOFF_MS;
        return current;
      }
      throw error;
    }
  }

  private usable(grant: Grant): boolean {
    return grant.expiresAt - this.now() > STALE_GRANT_MARGIN_MS;
  }

  private invalidate(grant: Grant): void {
    if (this.classGrant) return;
    const slot = this.cache.slot(this.cacheKey);
    if (slot.grant === grant) delete slot.grant;
  }

  private async exchange(): Promise<Grant> {
    const config = this.config;
    if ("groupKey" in config)
      throw new TkslopperError("Class keys are not exchanged", false);
    // Expiry is measured from before the request so round-trip latency never
    // makes a grant look longer-lived than the control plane issued it.
    const requestedAt = this.now();
    let response: Response;
    try {
      response = await this.dispatch(
        config.controlPlane,
        "/v1/token",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.serviceCredential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            capabilities: this.capabilities,
            ttl_seconds: GRANT_TTL_SECONDS,
          }),
          signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
        },
      );
    } catch (error) {
      console.error(`tkslopper grant exchange failed: ${failureDetail(error)}`);
      throw new TkslopperError(
        `Model access grant ${describeFailure(error)}`,
        true,
      );
    }
    const requestId = response.headers.get("x-tkslopper-request-id") ?? undefined;
    const body = (await response.json().catch(() => null)) as
      | (ErrorBody & {
          access_token?: unknown;
          token_type?: unknown;
          expires_in?: unknown;
          capabilities?: unknown;
        })
      | null;
    if (!response.ok) {
      const code =
        typeof body?.error?.code === "string" ? body.error.code : "unknown";
      console.error(
        `tkslopper grant exchange failed: HTTP ${response.status} ${code}${requestId ? ` (request ${requestId})` : ""}`,
      );
      throw new TkslopperError(
        `Model access grant failed: HTTP ${response.status} ${code}`,
        retryableStatus(response.status),
        response.status,
        requestId,
      );
    }
    if (
      typeof body?.access_token !== "string" ||
      !body.access_token ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0
    ) {
      console.error(
        `tkslopper grant exchange returned a malformed grant${requestId ? ` (request ${requestId})` : ""}`,
      );
      throw new TkslopperError(
        "Malformed model access grant",
        true,
        response.status,
        requestId,
      );
    }
    if (
      typeof body.token_type !== "string" ||
      body.token_type.toLowerCase() !== "bearer"
    ) {
      console.error(
        `tkslopper grant exchange returned an unsupported token type${requestId ? ` (request ${requestId})` : ""}`,
      );
      throw new TkslopperError(
        "Unsupported model access grant token type",
        false,
        response.status,
        requestId,
      );
    }
    const granted = Array.isArray(body.capabilities) ? body.capabilities : [];
    const missing = this.capabilities.filter((alias) => !granted.includes(alias));
    if (missing.length) {
      console.error(
        `tkslopper grant is missing capabilities ${missing.join(", ")}${requestId ? ` (request ${requestId})` : ""}`,
      );
      throw new TkslopperError(
        "Model access grant lacks a capability",
        false,
        response.status,
        requestId,
      );
    }
    const lifetime = body.expires_in * 1_000;
    const expiresAt = requestedAt + lifetime;
    // Refresh a minute early, or halfway through a grant shorter than two
    // minutes, so a short environment TTL cannot force an exchange per call.
    return {
      accessToken: body.access_token,
      expiresAt,
      refreshAt: expiresAt - Math.min(GRANT_REFRESH_MARGIN_MS, lifetime / 2),
    };
  }
}
