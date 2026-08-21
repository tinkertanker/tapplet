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

  it("reports the provider-specific missing credential", async () => {
    const provider = createModelProvider(env({ AI_PROVIDER: "openrouter" }));

    await expect(provider.generate(brief, [])).rejects.toThrow(
      "OPENROUTER_API_KEY",
    );
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
