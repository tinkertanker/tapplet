import { afterEach, describe, expect, it, vi } from "vitest";
import { loadModelCatalogue } from "../src/ai/modelCatalogue";

const model = { id: "new-model", provider: "openai", display_name: "New model", tier: "balanced", is_default: true };
const catalogue = (data: unknown[] = [model]) => ({ object: "list", version: 1, data });
const fallback = {
  source: "fallback",
  data: [
    { id: "gpt-6-luna", provider: "openai", display_name: "GPT-6 Luna", tier: "economy", is_default: true },
    { id: "claude-haiku-5-5", provider: "anthropic", display_name: "Claude Haiku 5.5", tier: "economy", is_default: true },
  ],
};

describe("public model catalogue", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("retains native provider IDs and display metadata, but drops transport/credential fields", async () => {
    const data = [
      { ...model, id: "vendor/model", provider: "openrouter", is_default: false },
      { ...model, provider: "opencode-zen" },
      { ...model, provider: "opencode-go" },
      { ...model, provider: "deepseek" },
      { ...model, provider: "gemini" },
      { ...model, provider: "anthropic" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalogue(data.map(entry => ({
      ...entry, base_url: "https://attacker.test", api_key: "not-a-key", transport: "messages",
    }))))));
    expect(await loadModelCatalogue("https://gateway.test/")).toEqual({ source: "tkslopper", data });
  });

  it.each([
    ["wrong version", { ...catalogue(), version: 2 }],
    ["wrong object", { ...catalogue(), object: "models" }],
    ["missing data", {}],
    ["unknown provider", catalogue([{ ...model, provider: "untrusted" }])],
    ["invalid tier", catalogue([{ ...model, tier: "flagship" }])],
    ["missing default flag", catalogue([{ id: "model", provider: "openai", display_name: "Model", tier: "economy" }])],
    ["blank ID", catalogue([{ ...model, id: " " }])],
    ["overlong label", catalogue([{ ...model, display_name: "x".repeat(201) }])],
    ["duplicate ID", catalogue([model, { ...model, is_default: false }])],
    ["duplicate default", catalogue([model, { ...model, id: "other" }])],
    ["too many entries", catalogue(Array.from({ length: 501 }, (_, i) => ({ ...model, id: `model-${i}`, is_default: false })))],
  ])("falls back for %s without partially trusting the response", async (_, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    expect(await loadModelCatalogue("https://gateway.test")).toEqual(fallback);
  });

  it.each([undefined, "not a URL", "http://gateway.test", "https://user:secret@gateway.test", "https://gateway.test/v1", "https://gateway.test?key=secret"])(
    "never fetches an absent or invalid configured origin: %s", async url => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      expect(await loadModelCatalogue(url)).toEqual(fallback);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["network", "http", "html", "json", "size"])("falls back for %s failures", async failure => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "network") throw new TypeError("Network failed");
      if (failure === "http") return new Response(null, { status: 503 });
      if (failure === "html") return new Response("<html>unexpected proxy</html>", { headers: { "content-type": "text/html" } });
      return new Response(failure === "size" ? " ".repeat(256_001) : "invalid json", { headers: { "content-type": "application/json" } });
    }));
    expect(await loadModelCatalogue("https://gateway.test")).toEqual(fallback);
  });

  it.each(["headers", "body"])("bounds a stalled %s fetch and aborts it", async stage => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    let close: (() => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_: unknown, init?: RequestInit) => {
      signal = init?.signal;
      if (stage === "headers") return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start(controller) { close = () => controller.close(); } }), {
        headers: { "content-type": "application/json" },
      });
    }));
    const pending = loadModelCatalogue("https://gateway.test");
    await vi.advanceTimersByTimeAsync(3_001);
    expect(await pending).toEqual(fallback);
    expect(signal?.aborted).toBe(true);
    close?.();
  });
});
