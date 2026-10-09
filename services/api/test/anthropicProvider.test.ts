import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/ai/anthropicProvider";
import { MemoryOperationalTraceSink } from "../src/operationalTrace";

const brief = {
  level: "P5",
  subject: "Maths",
  learningObjective: "Fractions",
  studentAction: "Choose",
};
const provider = () =>
  new AnthropicProvider({
    model: "claude-haiku-5-5",
    apiKey: "test-only-key",
    baseUrl: "https://api.anthropic.com/v1",
    effort: "high",
  });

describe("Anthropic model operations", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects redirects without sending the credential to another origin", async () => {
    const redirectedRequests: { authenticated: boolean }[] = [];
    let sourceAuthenticated = false;
    const destination = createServer((request, response) => {
      redirectedRequests.push({
        authenticated: request.headers["x-api-key"] === "test-only-key",
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: '{"html":"redirected"}' }],
        }),
      );
    });
    const source = createServer((request, response) => {
      sourceAuthenticated = request.headers["x-api-key"] === "test-only-key";
      response.writeHead(307, {
        location: `http://127.0.0.1:${(destination.address() as AddressInfo).port}/messages`,
      });
      response.end();
    });
    try {
      destination.listen(0, "127.0.0.1");
      await once(destination, "listening");
      source.listen(0, "127.0.0.1");
      await once(source, "listening");
      const p = new AnthropicProvider({
        model: "claude-haiku-5-5",
        apiKey: "test-only-key",
        baseUrl: `http://127.0.0.1:${(source.address() as AddressInfo).port}/v1`,
      });
      const outcome = await p
        .generate(brief, [])
        .catch((error: unknown) => error);
      expect(sourceAuthenticated).toBe(true);
      expect(redirectedRequests).toEqual([]);
      expect(outcome).toMatchObject({ message: "Anthropic HTTP 307", retryable: false });
    } finally {
      await Promise.all(
        [source, destination].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
    }
  });

  it("revises, repairs and moderates with bounded prompts, schemas and private usage traces", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({
          id: "msg-test",
          model: "claude-haiku-5-5",
          stop_reason: "end_turn",
          content: [
            { type: "thinking", thinking: "do not log" },
            {
              type: "text",
              text:
                bodies.length === 3
                  ? '{"safe":false,"categories":["privacy"],"reason":"Personal information"}'
                  : '{"html":"updated","designCard":{}}',
            },
          ],
          usage: {
            input_tokens: 23,
            cache_read_input_tokens: 7,
            cache_creation_input_tokens: 11,
            output_tokens: 13,
          },
        });
      }),
    );
    const sink = new MemoryOperationalTraceSink();
    const trace = { requestId: "trace-test", sink };
    const p = provider();
    await expect(
      p.revise("private source", undefined, "Add reset", brief, trace),
    ).resolves.toMatchObject({ html: "updated" });
    await p.repair(
      { html: "private source" },
      ["Missing reset"],
      { brief },
      trace,
    );
    await expect(p.moderate("private source", trace)).resolves.toEqual({
      safe: false,
      categories: ["privacy"],
    });
    expect(JSON.stringify(bodies[0]?.messages)).toContain(
      "BEGIN UNTRUSTED CURRENT HTML",
    );
    expect(JSON.stringify(bodies[1]?.messages)).toContain(
      "BEGIN UNTRUSTED CANDIDATE DATA",
    );
    expect(bodies[0]).toMatchObject({ output_config: { effort: "high" } });
    expect(bodies[2]).toMatchObject({
      max_tokens: 4096,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            required: ["safe", "categories", "reason"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(sink.events).toHaveLength(3);
    expect(sink.events[0]).toMatchObject({
      status: "success",
      inputTokens: 41,
      cachedInputTokens: 7,
      outputTokens: 13,
      totalTokens: 54,
    });
    expect(JSON.stringify(sink.events)).not.toMatch(
      /private source|do not log|test-only-key/,
    );
  });

  it.each([
    ["refusal", false, "refused"],
    ["max_tokens", true, "truncated"],
    ["model_context_window_exceeded", true, "truncated"],
    ["tool_use", true, "incomplete"],
  ])(
    "rejects %s even when the body contains valid JSON",
    async (stopReason, retryable, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            stop_reason: stopReason,
            content: [{ type: "text", text: '{"html":"must not accept"}' }],
          }),
        ),
      );
      const sink = new MemoryOperationalTraceSink();
      await expect(
        provider().generate(brief, [], { requestId: "error-test", sink }),
      ).rejects.toMatchObject({
        retryable,
        message: expect.stringContaining(message as string),
      });
      expect(sink.events[0]).toMatchObject({
        status: "error",
        finishReason: stopReason,
      });
    },
  );

  it.each([
    [401, false],
    [429, true],
    [529, true],
  ])(
    "maps HTTP %s without echoing the provider error body",
    async (status, retryable) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            { error: { message: "sensitive input" } },
            { status: status as number },
          ),
        ),
      );
      await expect(provider().generate(brief, [])).rejects.toMatchObject({
        message: `Anthropic HTTP ${status}`,
        retryable,
      });
    },
  );

  it.each([
    { content: [] },
    { content: [{ type: "thinking", thinking: "not an answer" }] },
  ])("rejects empty text output", async ({ content }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ stop_reason: "end_turn", content })),
    );
    await expect(provider().generate(brief, [])).rejects.toThrow(
      "No model output",
    );
  });

  it("does not accept malformed JSON or invalid moderation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "not json" }],
        }),
      ),
    );
    await expect(provider().generate(brief, [])).rejects.toMatchObject({
      retryable: false,
      message: "Malformed model JSON",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          stop_reason: "end_turn",
          content: [{ type: "text", text: '{"safe":true,"categories":[42]}' }],
        }),
      ),
    );
    await expect(provider().moderate("html")).rejects.toThrow(
      "Invalid moderation response",
    );
  });
});
