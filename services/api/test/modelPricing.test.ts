import { describe, expect, it } from "vitest";
import { findModelPricing } from "../src/ai/modelPricing";

const list = { data: [
  { id: "anthropic/claude-haiku-5.5:batch", name: "Batch", pricing: { prompt: "0.0000005", completion: "0.0000025" } },
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", pricing: { prompt: "0.000001", completion: "0.000005" } },
  { id: "openai/gpt-6-luna", name: "GPT-6 Luna", pricing: { prompt: "0.0000001", completion: "0.0000005" } },
  { id: "vendor/broken", name: "Broken", pricing: { prompt: "-1", completion: "free" } },
] };

describe("model list prices", () => {
  it("matches OpenRouter IDs exactly and native IDs by name, ignoring variants", () => {
    expect(findModelPricing(list, "openai/gpt-6-luna")).toMatchObject({ inputPerMillion: 0.1, outputPerMillion: 0.5 });
    expect(findModelPricing(list, "claude-haiku-5-5")).toMatchObject({ id: "anthropic/claude-haiku-5.5", inputPerMillion: 1, outputPerMillion: 5 });
  });

  it.each(["broken", "missing", ""])("returns null for unusable entries: %s", model => {
    expect(findModelPricing(list, model)).toBeNull();
  });

  it("rejects malformed lists", () => {
    expect(findModelPricing({ models: [] }, "gpt-6-luna")).toBeNull();
    expect(findModelPricing(null, "gpt-6-luna")).toBeNull();
  });
});
