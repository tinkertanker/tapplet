import type { StudioEnv } from "../../env";
import type { ModelOperation } from "../../operationalTrace";

// tkslopper is Tinkertanker's managed inference boundary. Tapplet exchanges a
// service credential for a short-lived grant on the control plane, then calls
// the gateway's narrow OpenAI-compatible subset with capability aliases.

export type PortableEffort = "low" | "medium" | "high";
export type TkslopperArtifactEndpoint = "responses" | "chat";
export type TkslopperOperation = ModelOperation | "image_review";

/** Where a tkslopper Worker is reached: a service binding or a public URL. */
export type TkslopperTarget = { binding: Fetcher } | { url: string };

/** Gateway routing shared by the service-credential and class-key modes. */
export interface TkslopperRouteConfig {
  gateway: TkslopperTarget;
  artifactAlias: string;
  reviewAlias: string;
  imageAlias: string;
  artifactEffort?: PortableEffort;
  reviewEffort?: PortableEffort;
  imageEffort?: PortableEffort;
  artifactEndpoint: TkslopperArtifactEndpoint;
  maxRequestBytes: number;
}

/** Fleet mode: a service credential exchanged for short-lived grants. */
export interface TkslopperConfig extends TkslopperRouteConfig {
  controlPlane: TkslopperTarget;
  serviceCredential: string;
}

/**
 * Class mode: a tkslopper classroom group key sent directly as the gateway
 * Bearer credential, so the class's aliases, budget, schedule and pause apply.
 */
export interface TkslopperClassConfig extends TkslopperRouteConfig {
  groupKey: string;
}

export type TkslopperClientConfig = TkslopperConfig | TkslopperClassConfig;

export type TkslopperConfigResult =
  | { ok: true; config: TkslopperConfig }
  | { ok: false; reason: string };

export type TkslopperClassConfigResult =
  | { ok: true; config: TkslopperClassConfig }
  | { ok: false; reason: string };

// Mirrors tkslopper's opaque credential format: tksvc_<id>_<secret>.
export const CREDENTIAL_PATTERN = /^tksvc_([A-Za-z0-9-]{8,64})_[A-Za-z0-9_-]{16,128}$/;
// Mirrors tkslopper's classroom group key format.
export const GROUP_KEY_PATTERN = /^tkgk_[A-Za-z0-9_-]{16,128}$/;
const ALIAS_PATTERN = /^[a-z][a-z0-9._:-]*\.v[1-9][0-9]*$/;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const MINIMUM_REQUEST_BYTES = 1_024;
const MAXIMUM_REQUEST_BYTES = 10_485_760;

export function inferenceTransport(env: StudioEnv): string {
  return env.INFERENCE_TRANSPORT?.trim() || "direct";
}

/**
 * Maps a configured effort to one the gateway accepts. tkslopper rejects
 * none, minimal, xhigh and max, so these become the nearest portable value;
 * undefined means the request omits reasoning entirely.
 *
 * Until tkslopper issue #13 lands, "high" is only the portable high effort,
 * not today's direct "xhigh"; physical efforts will then be trusted route
 * policy owned by the operators.
 */
export function portableEffort(
  value: string,
): PortableEffort | undefined | null {
  switch (value) {
    case "low":
    case "medium":
    case "high":
      return value;
    case "xhigh":
    case "max":
      return "high";
    case "minimal":
      return "low";
    case "none":
    case "omit":
      return undefined;
    default:
      return null;
  }
}

/**
 * Resolves a tkslopper Worker target. A service binding wins when present;
 * the URL is then optional but still validated if set. tkslopper routes on the
 * exact path, so the URL must be an HTTPS origin without a path prefix.
 */
function serviceTarget(
  name: string,
  value: string | undefined,
  binding: Fetcher | undefined,
): { target?: TkslopperTarget; problem?: string } {
  const problem = `${name} must be an HTTPS origin such as https://tkslopper.example`;
  let url: string | undefined;
  if (value?.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(value.trim());
    } catch {
      return { problem };
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    )
      return { problem };
    url = parsed.origin;
  }
  if (binding) {
    if (typeof binding.fetch !== "function")
      return { problem: `${name.replace(/_URL$/, "")} must be a service binding` };
    return { target: { binding } };
  }
  return url ? { target: { url } } : { problem };
}

function isArtifactEndpoint(value: string): value is TkslopperArtifactEndpoint {
  return value === "responses" || value === "chat";
}

export function readTkslopperConfig(env: StudioEnv): TkslopperConfigResult {
  const problems: string[] = [];
  const controlPlane = serviceTarget(
    "TKSLOPPER_CONTROL_PLANE_URL",
    env.TKSLOPPER_CONTROL_PLANE_URL,
    env.TKSLOPPER_CONTROL_PLANE,
  );
  if (controlPlane.problem) problems.push(controlPlane.problem);

  const serviceCredential = env.TKSLOPPER_SERVICE_CREDENTIAL?.trim() ?? "";
  if (!CREDENTIAL_PATTERN.test(serviceCredential))
    problems.push(
      "TKSLOPPER_SERVICE_CREDENTIAL must be a tksvc_ service credential secret",
    );

  const route = readRouteConfig(env, problems);
  if (problems.length || !controlPlane.target || !route)
    return {
      ok: false,
      reason: `tkslopper transport is misconfigured: ${problems.join("; ")}.`,
    };
  return {
    ok: true,
    config: { ...route, controlPlane: controlPlane.target, serviceCredential },
  };
}

/**
 * Reads the gateway routing for a class's group key. It needs neither the
 * control plane nor the service credential, and is independent of
 * INFERENCE_TRANSPORT, so a class can use tkslopper before the fleet does.
 */
export function readTkslopperClassConfig(
  env: StudioEnv,
  groupKey: string,
): TkslopperClassConfigResult {
  const problems: string[] = [];
  if (!GROUP_KEY_PATTERN.test(groupKey))
    problems.push("the class key must be a tkgk_ classroom group key");
  const route = readRouteConfig(env, problems);
  if (problems.length || !route)
    return {
      ok: false,
      reason: `tkslopper class access is misconfigured: ${problems.join("; ")}.`,
    };
  return { ok: true, config: { ...route, groupKey } };
}

function readRouteConfig(
  env: StudioEnv,
  problems: string[],
): TkslopperRouteConfig | undefined {
  const gateway = serviceTarget(
    "TKSLOPPER_GATEWAY_URL",
    env.TKSLOPPER_GATEWAY_URL,
    env.TKSLOPPER_GATEWAY,
  );
  if (gateway.problem) problems.push(gateway.problem);
  const aliases = {
    artifactAlias: env.TKSLOPPER_ARTIFACT_ALIAS?.trim() ?? "",
    reviewAlias: env.TKSLOPPER_REVIEW_ALIAS?.trim() ?? "",
    imageAlias: env.TKSLOPPER_IMAGE_ALIAS?.trim() ?? "",
  };
  for (const [key, name] of [
    ["artifactAlias", "TKSLOPPER_ARTIFACT_ALIAS"],
    ["reviewAlias", "TKSLOPPER_REVIEW_ALIAS"],
    ["imageAlias", "TKSLOPPER_IMAGE_ALIAS"],
  ] as const) {
    const alias = aliases[key];
    if (alias.length < 2 || alias.length > 100 || !ALIAS_PATTERN.test(alias))
      problems.push(`${name} must be a capability alias such as tapplet.artifact.v1`);
  }

  const efforts: Record<
    "artifactEffort" | "reviewEffort" | "imageEffort",
    PortableEffort | undefined
  > = { artifactEffort: undefined, reviewEffort: undefined, imageEffort: undefined };
  for (const [key, name, value, fallback] of [
    ["artifactEffort", "TKSLOPPER_ARTIFACT_EFFORT", env.TKSLOPPER_ARTIFACT_EFFORT, "high"],
    ["reviewEffort", "TKSLOPPER_REVIEW_EFFORT", env.TKSLOPPER_REVIEW_EFFORT, "low"],
    ["imageEffort", "TKSLOPPER_IMAGE_EFFORT", env.TKSLOPPER_IMAGE_EFFORT, "omit"],
  ] as const) {
    const effort = portableEffort(value?.trim() || fallback);
    if (effort === null)
      problems.push(`${name} must be low, medium, high or omit`);
    else efforts[key] = effort;
  }

  const endpoint = env.TKSLOPPER_ARTIFACT_ENDPOINT?.trim() || "responses";
  if (!isArtifactEndpoint(endpoint))
    problems.push("TKSLOPPER_ARTIFACT_ENDPOINT must be responses or chat");

  const maxRequestBytesValue = env.TKSLOPPER_MAX_REQUEST_BYTES?.trim();
  const maxRequestBytes = maxRequestBytesValue
    ? Number(maxRequestBytesValue)
    : DEFAULT_MAX_REQUEST_BYTES;
  if (
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes < MINIMUM_REQUEST_BYTES ||
    maxRequestBytes > MAXIMUM_REQUEST_BYTES
  )
    problems.push(
      `TKSLOPPER_MAX_REQUEST_BYTES must be a whole number from ${MINIMUM_REQUEST_BYTES} to ${MAXIMUM_REQUEST_BYTES}`,
    );

  if (problems.length || !gateway.target || !isArtifactEndpoint(endpoint))
    return undefined;
  return {
    gateway: gateway.target,
    ...aliases,
    ...(efforts.artifactEffort ? { artifactEffort: efforts.artifactEffort } : {}),
    ...(efforts.reviewEffort ? { reviewEffort: efforts.reviewEffort } : {}),
    ...(efforts.imageEffort ? { imageEffort: efforts.imageEffort } : {}),
    artifactEndpoint: endpoint,
    maxRequestBytes,
  };
}
