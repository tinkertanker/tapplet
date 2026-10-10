import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelProvider } from "../src/ai/createProvider";
import type { StudioEnv } from "../src/env";

const brief = {
  level: "P5",
  subject: "Maths",
  learningObjective: "Fractions",
  studentAction: "Choose",
};

function env(values: Partial<StudioEnv>): StudioEnv {
  return {
    AI_PROVIDER: "fixture",
    AI_MODEL: "test-model",
    AI_BASE_URL: "https://models.example.test/v1",
    PUBLIC_PLAYER_ORIGIN: "https://tapplet.example.test",
    ...values,
  } as StudioEnv;
}

describe("model provider selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["https://opencode.ai/zen/go/v1/", true],
    ["https://opencode.ai/zen/v1", false],
    ["https://opencode.ai.example.test/zen/go/v1", false],
    ["https://models.example.test/v1", false],
  ])("scopes OpenCode session headers to the native Go endpoint: %s", async (baseUrl, nativeGo) => {
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    const provider = createModelProvider(env({}), {
      provider: "opencode-go", model: "kimi-k3", baseUrl, apiKey: "test-key",
    });
    await provider.generate(brief, []);
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    if (nativeGo) {
      expect(headers.get("x-opencode-session")).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
      expect(headers.get("user-agent")).toBe("tapplet-studio/0.1");
    } else {
      expect(headers.has("x-opencode-session")).toBe(false);
      expect(headers.has("user-agent")).toBe(false);
    }
  });

  it("uses native Anthropic Messages with an isolated credential and ignores thinking blocks", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: '{"html":"test"}' },
      ],
    }));
    vi.stubGlobal("fetch", fetch);
    const provider = createModelProvider(env({
      AI_PROVIDER: "anthropic",
      AI_MODEL: "claude-haiku-5-5",
      ANTHROPIC_API_KEY: "anthropic-test-key",
      AI_API_KEY: "unrelated-test-key",
    }));
    await expect(provider.generate(brief, [])).resolves.toEqual({ html: "test" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      "x-api-key": "anthropic-test-key",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    const body = requestBody(fetch);
    expect(body).toMatchObject({
      model: "claude-haiku-5-5", max_tokens: 32000, stream: false,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: { required: ["html", "designCard"] } } },
      messages: [{ role: "user", content: expect.any(String) }],
      system: expect.any(String),
    });
    for (const field of ["temperature", "top_p", "seed", "response_format", "tools"])
      expect(body).not.toHaveProperty(field);
    await expect(createModelProvider(env({ AI_PROVIDER: "anthropic", AI_API_KEY: "wrong-key" }))
      .generate(brief, [])).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  it.each(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"])("uses Responses without sampling for OpenAI %s", async (model) => {
    const fetch = successfulResponsesFetch();
    vi.stubGlobal("fetch", fetch);
    const provider = createModelProvider(env({ AI_PROVIDER: "openai-compatible", AI_MODEL: model,
      AI_BASE_URL: "https://api.openai.com/v1", AI_API_KEY: "openai-test-key" }));
    await provider.generate(brief, []);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
    expect(requestBody(fetch)).toMatchObject({ model, store: false, max_output_tokens: 32000, reasoning: { effort: "medium" } });
    expect(requestBody(fetch)).not.toHaveProperty("temperature");
    fetch.mockClear();
    fetch.mockResolvedValueOnce(Response.json({ output: [{ content: [{ type: "output_text", text: '{"safe":true,"categories":[]}' }] }] }));
    await expect(provider.moderate("html")).resolves.toEqual({ safe: true, categories: [] });
    expect(requestBody(fetch)).toMatchObject({ model, store: false, max_output_tokens: 4096, reasoning: { effort: "low" } });
  });

  it("preserves an older OpenAI model and its chat dialect", async () => {
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    await createModelProvider(env({ AI_PROVIDER: "openai-compatible", AI_MODEL: "gpt-4.1",
      AI_BASE_URL: "https://api.openai.com/v1", AI_API_KEY: "test-key" })).generate(brief, []);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(requestBody(fetch).model).toBe("gpt-4.1");
    expect(requestBody(fetch)).not.toHaveProperty("reasoning");
  });

  it("uses OpenCode Zen with its dedicated credential", async () => {
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    const provider = createModelProvider(
      env({
        AI_PROVIDER: "opencode",
        AI_MODEL: "deepseek-v4-flash",
        OPENCODE_API_KEY: "opencode-secret",
      }),
    );

    await provider.generate(brief, []);

    expect(provider.name).toBe("opencode:deepseek-v4-flash");
    expect(fetch).toHaveBeenCalledWith(
      "https://opencode.ai/zen/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer opencode-secret",
        }),
      }),
    );
    expect(requestBody(fetch)).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });

  it("omits DeepSeek reasoning fields for other OpenCode chat models", async () => {
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    const provider = createModelProvider(
      env({
        AI_PROVIDER: "opencode-go",
        AI_MODEL: "kimi-k3",
        OPENCODE_API_KEY: "opencode-secret",
      }),
    );

    await provider.generate(brief, []);

    const body = requestBody(fetch);
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("uses the OpenCode Go chat-completions endpoint", async () => {
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    const provider = createModelProvider(
      env({
        AI_PROVIDER: "opencode-go",
        AI_MODEL: "deepseek-v4-flash",
        OPENCODE_API_KEY: "opencode-secret",
      }),
    );

    await provider.generate(brief, []);

    expect(provider.name).toBe("opencode-go:deepseek-v4-flash");
    expect(fetch).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer opencode-secret",
        }),
      }),
    );
    expect(requestBody(fetch)).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });

  it("uses the OpenCode Go Responses API for Muse Spark", async () => {
    const fetch = successfulResponsesFetch();
    vi.stubGlobal("fetch", fetch);
    const provider = createModelProvider(
      env({
        AI_PROVIDER: "opencode-go",
        AI_MODEL: "muse-spark-1.2-contributor",
        OPENCODE_API_KEY: "opencode-secret",
      }),
    );

    await provider.generate(brief, []);

    expect(provider.name).toBe("opencode-go:muse-spark-1.2-contributor");
    expect(fetch).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/responses",
      expect.anything(),
    );
    expect(requestBody(fetch)).toMatchObject({
      model: "muse-spark-1.2-contributor",
      reasoning: { effort: "xhigh" },
      text: { format: { type: "json_object" } },
    });

    fetch.mockClear();
    fetch.mockResolvedValueOnce(Response.json({
      output: [{
        content: [{
          type: "output_text",
          text: JSON.stringify({ safe: true, categories: [] }),
        }],
      }],
    }));
    await provider.moderate("<html></html>");
    expect(requestBody(fetch)).toMatchObject({
      reasoning: { effort: "minimal" },
    });
  });

  it("uses OpenRouter with its dedicated credential and attribution", async () => {
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    const provider = createModelProvider(
      env({
        AI_PROVIDER: "openrouter",
        AI_MODEL: "vendor/model",
        OPENROUTER_API_KEY: "openrouter-secret",
      }),
    );

    await provider.generate(brief, []);

    expect(provider.name).toBe("openrouter:vendor/model");
    expect(fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer openrouter-secret",
          "HTTP-Referer": "https://tapplet.example.test",
          "X-OpenRouter-Title": "Tapplet Studio",
        }),
      }),
    );
    expect(requestBody(fetch)).toMatchObject({
      reasoning: { effort: "xhigh", exclude: true },
    });
  });

  it("uses AI_REASONING_EFFORT instead of the provider default effort", async () => {
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    const provider = createModelProvider(
      env({
        AI_PROVIDER: "openrouter",
        AI_MODEL: "vendor/model",
        AI_REASONING_EFFORT: "low",
        OPENROUTER_API_KEY: "openrouter-secret",
      }),
    );

    await provider.generate(brief, []);

    expect(requestBody(fetch)).toMatchObject({
      reasoning: { effort: "low", exclude: true },
    });
  });

  it("fails closed on an unsupported AI_REASONING_EFFORT", async () => {
    const provider = createModelProvider(
      env({
        AI_PROVIDER: "openrouter",
        AI_REASONING_EFFORT: "turbo",
        OPENROUTER_API_KEY: "openrouter-secret",
      }),
    );

    await expect(provider.generate(brief, [])).rejects.toThrow(
      "AI_REASONING_EFFORT",
    );
  });

  it("reports the provider-specific missing credential", async () => {
    const provider = createModelProvider(env({ AI_PROVIDER: "openrouter" }));

    await expect(provider.generate(brief, [])).rejects.toThrow(
      "OPENROUTER_API_KEY",
    );
  });

  it("supports explicit evaluation-only reasoning and prompt-boundary overrides", async () => {
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    const provider = createModelProvider(
      env({
        AI_PROVIDER: "openrouter",
        AI_MODEL: "vendor/model",
        OPENROUTER_API_KEY: "openrouter-secret",
      }),
      {
        provider: "openrouter",
        model: "vendor/model",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "openrouter-secret",
        reasoningEffort: "low",
        promptBoundaryMode: "legacy-unbounded",
      },
    );

    await provider.revise(
      "<!doctype html><html><body>source</body></html>",
      undefined,
      "Add a reset.",
      brief,
    );

    expect(requestBody(fetch)).toMatchObject({
      reasoning: { effort: "low", exclude: true },
    });
    expect(JSON.stringify(requestBody(fetch).messages)).not.toContain(
      "BEGIN UNTRUSTED CURRENT HTML",
    );
  });

  it("enables DeepSeek reasoning only for an explicit evaluation override", async () => {
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    const provider = createModelProvider(
      env({}),
      {
        provider: "openai-compatible",
        model: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com",
        apiKey: "evaluation-secret",
        reasoningEffort: "low",
      },
    );

    await provider.generate(brief, []);

    expect(requestBody(fetch)).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
  });
});

function successfulFetch() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({
      choices: [{ message: { content: JSON.stringify({ html: "test" }) } }],
    }),
  );
}

function successfulResponsesFetch() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({
      output: [
        {
          content: [
            { type: "output_text", text: JSON.stringify({ html: "test" }) },
          ],
        },
      ],
    }),
  );
}

function requestBody(fetch: ReturnType<typeof successfulFetch> | ReturnType<typeof successfulResponsesFetch>) {
  const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}
