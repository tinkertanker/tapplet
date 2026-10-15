import { readBodyBytes } from "../http";

export interface ModelPricing {
  source: "openrouter";
  id: string;
  name: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// OpenRouter reports USD per token as decimal strings.
function perMillion(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(\.\d+)?(e-?\d+)?$/i.test(value)) return null;
  const amount = Number(value) * 1_000_000;
  return Number.isFinite(amount) && amount < 10_000 ? Math.round(amount * 1e6) / 1e6 : null;
}

// Matches "openai/gpt-6-luna" exactly, or a native ID such as
// "claude-haiku-5-5" against "anthropic/claude-haiku-5.5". Batch and other
// ":variant" listings are only chosen when requested exactly.
function canonical(id: string): string {
  return id.toLowerCase().replace(/\./g, "-");
}

export function findModelPricing(value: unknown, model: string): ModelPricing | null {
  if (!record(value) || !Array.isArray(value.data)) return null;
  const wanted = canonical(model.trim());
  if (!wanted) return null;
  let suffixMatch: ModelPricing | null = null;
  for (const entry of value.data) {
    if (!record(entry) || typeof entry.id !== "string") continue;
    const id = canonical(entry.id);
    const exact = id === wanted;
    if (!exact && (id.includes(":") || id.split("/").pop() !== wanted)) continue;
    const pricing = record(entry.pricing) ? entry.pricing : {};
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    if (input === null || output === null) continue;
    const match: ModelPricing = {
      source: "openrouter",
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name.slice(0, 200) : entry.id,
      inputPerMillion: input,
      outputPerMillion: output,
    };
    if (exact) return match;
    suffixMatch ??= match;
  }
  return suffixMatch;
}

/** Public list prices for the cost estimator; null when unavailable. */
export async function loadModelPricing(model: string): Promise<ModelPricing | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      await response.body?.cancel();
      return null;
    }
    const bytes = await readBodyBytes(response, 4_000_000);
    return findModelPricing(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), model);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
