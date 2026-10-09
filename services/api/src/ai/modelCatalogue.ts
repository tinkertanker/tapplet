import { readBodyBytes } from "../http";

export interface CatalogueModel {
  id: string;
  provider: string;
  display_name: string;
  tier: "economy" | "balanced" | "premium";
  is_default: boolean;
}

// Suggestions only. Saved/custom IDs and managed capability aliases are never
// validated against this list, and catalogue metadata cannot configure transport.
export const BUNDLED_MODELS: CatalogueModel[] = [
  { id: "gpt-6-luna", provider: "openai", display_name: "GPT-6 Luna", tier: "economy", is_default: true },
  { id: "claude-haiku-5-5", provider: "anthropic", display_name: "Claude Haiku 5.5", tier: "economy", is_default: true },
];

export const MODEL_PROVIDERS = new Set([
  "openai", "anthropic", "gemini", "deepseek", "openrouter", "opencode-go", "opencode-zen",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCatalogue(value: unknown): CatalogueModel[] {
  if (!record(value) || value.object !== "list" || value.version !== 1 ||
    !Array.isArray(value.data) || value.data.length > 500) throw new Error("Invalid catalogue");
  const seen = new Set<string>();
  const defaults = new Set<string>();
  return value.data.map((entry: unknown) => {
    if (!record(entry)) throw new Error("Invalid model");
    const { id, provider, display_name, tier, is_default } = entry;
    if (typeof id !== "string" || !/^[^\s\x00-\x1f\x7f]{1,200}$/.test(id) ||
      typeof provider !== "string" || !MODEL_PROVIDERS.has(provider) ||
      typeof display_name !== "string" || !display_name.trim() || display_name.length > 200 ||
      /[\x00-\x1f\x7f]/.test(display_name) ||
      (tier !== "economy" && tier !== "balanced" && tier !== "premium") ||
      typeof is_default !== "boolean") throw new Error("Invalid model");
    const key = `${provider}:${id}`;
    if (seen.has(key) || (is_default && defaults.has(provider))) throw new Error("Duplicate model/default");
    seen.add(key);
    if (is_default) defaults.add(provider);
    // Deliberately copy only display metadata, never URLs or credentials.
    return { id, provider, display_name, tier, is_default };
  });
}

export async function loadModelCatalogue(gatewayUrl: string | undefined): Promise<{
  source: "tkslopper" | "fallback";
  data: CatalogueModel[];
}> {
  const fallback = { source: "fallback" as const, data: BUNDLED_MODELS };
  let url: URL;
  try {
    url = new URL(gatewayUrl ?? "");
    if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) return fallback;
  } catch { return fallback; }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The deadline covers headers AND body reads, including a stalled stream.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Catalogue timed out"));
    }, 3_000);
  });
  try {
    const data = await Promise.race([
      (async () => {
        const response = await fetch(new URL("/v1/model-catalogue", url), {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "omit",
          redirect: "manual",
          signal: controller.signal,
        });
        if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
          await response.body?.cancel();
          throw new Error("Catalogue unavailable");
        }
        const bytes = await readBodyBytes(response, 256_000);
        return parseCatalogue(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      })(),
      deadline,
    ]);
    return { source: "tkslopper", data };
  } catch { return fallback; }
  finally { clearTimeout(timer); controller.abort(); }
}
