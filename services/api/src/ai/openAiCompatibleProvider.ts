import {
  generationPrompt,
  MODERATION_SYSTEM_PROMPT,
  repairPrompt,
  revisionPrompt,
  SYSTEM_PROMPT,
} from "./prompts";
import type { PromptBoundaryMode } from "./prompts";
import type {
  DesignCard,
  Exemplar,
  ModelProvider,
  ModerationDecision,
  RepairContext,
  TeacherBrief,
} from "./provider";
import { ModelProviderError } from "./provider";
import type {
  ModelOperation,
  OperationalTraceContext,
} from "../operationalTrace";
import { emitOperationalTrace } from "../operationalTrace";
export interface OpenAiCompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  api?: "chat-completions" | "responses";
  providerName?: string;
  headers?: Readonly<Record<string, string>>;
  reasoningOptions?: Readonly<Record<string, unknown>>;
  moderationReasoningOptions?: Readonly<Record<string, unknown>>;
  promptBoundaryMode?: PromptBoundaryMode;
  fetch?: typeof fetch;
}
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name: string;
  private f: typeof fetch;
  constructor(private o: OpenAiCompatibleProviderOptions) {
    this.name = `${o.providerName ?? "openai-compatible"}:${o.model}`;
    this.f = o.fetch ?? globalThis.fetch.bind(globalThis);
  }
  generate(b: TeacherBrief, e: Exemplar[], trace?: OperationalTraceContext) {
    return this.complete(
      SYSTEM_PROMPT,
      generationPrompt(b, e, this.o.promptBoundaryMode),
      32000,
      false,
      this.o.reasoningOptions,
      "generate",
      trace,
    );
  }
  revise(
    h: string,
    c: DesignCard | undefined,
    i: string,
    b: TeacherBrief,
    trace?: OperationalTraceContext,
  ) {
    return this.complete(
      SYSTEM_PROMPT,
      revisionPrompt(h, c, i, b, this.o.promptBoundaryMode),
      32000,
      false,
      this.o.reasoningOptions,
      "revise",
      trace,
    );
  }
  repair(
    c: unknown,
    i: string[],
    context?: RepairContext,
    trace?: OperationalTraceContext,
  ) {
    return this.complete(
      SYSTEM_PROMPT,
      repairPrompt(c, i, context, this.o.promptBoundaryMode),
      32000,
      false,
      this.o.reasoningOptions,
      "repair",
      trace,
    );
  }
  async moderate(
    html: string,
    trace?: OperationalTraceContext,
  ): Promise<ModerationDecision> {
    const r = await this.complete(
      MODERATION_SYSTEM_PROMPT,
      html,
      500,
      true,
      this.o.moderationReasoningOptions,
      "moderate",
      trace,
    );
    if (
      !r ||
      typeof r !== "object" ||
      typeof Reflect.get(r, "safe") !== "boolean" ||
      !Array.isArray(Reflect.get(r, "categories"))
    )
      throw new ModelProviderError("Invalid moderation response", true);
    return {
      safe: Reflect.get(r, "safe") as boolean,
      categories: Reflect.get(r, "categories") as string[],
    };
  }
  private async complete(
    system: string,
    user: string,
    max_tokens: number,
    requireJson = false,
    reasoningOptions?: Readonly<Record<string, unknown>>,
    operation: ModelOperation = "generate",
    trace?: OperationalTraceContext,
  ): Promise<unknown> {
    const responsesApi = this.o.api === "responses";
    const started = performance.now();
    const systemBytes = new TextEncoder().encode(system).byteLength;
    const inputBytes = new TextEncoder().encode(user).byteLength;
    let response: Response;
    try {
      response = await this.f(
        `${this.o.baseUrl.replace(/\/$/, "")}/${responsesApi ? "responses" : "chat/completions"}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.o.apiKey}`,
            "content-type": "application/json",
            ...this.o.headers,
          },
          body: JSON.stringify(
            responsesApi
              ? {
                  model: this.o.model,
                  instructions: system,
                  input: user,
                  text: { format: { type: "json_object" } },
                  max_output_tokens: max_tokens,
                  ...reasoningOptions,
                }
              : {
                  model: this.o.model,
                  messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                  ],
                  response_format: { type: "json_object" },
                  max_tokens,
                  temperature: 0.2,
                  ...(new URL(this.o.baseUrl).hostname === "api.deepseek.com"
                    ? { thinking: { type: "disabled" } }
                    : {}),
                  ...reasoningOptions,
                },
          ),
          signal: AbortSignal.timeout(45000),
        },
      );
    } catch (e) {
      this.emitTrace(trace, {
        operation,
        status: "error",
        durationMs: Math.round(performance.now() - started),
        systemBytes,
        inputBytes,
      });
      throw new ModelProviderError(
        e instanceof Error ? e.message : "Model failed",
        true,
      );
    }
    const body = (await response.json().catch(() => null)) as {
      id?: string;
      model?: string;
      choices?: { finish_reason?: string; message?: { content?: string } }[];
      output?: { content?: { type?: string; text?: string }[] }[];
      status?: string;
      incomplete_details?: { reason?: string };
      error?: { message?: string };
      usage?: ProviderUsage;
    } | null;
    if (!response.ok) {
      this.emitTrace(trace, this.traceEvent(
        operation,
        "error",
        started,
        systemBytes,
        inputBytes,
        body,
      ));
      throw new ModelProviderError(
        body?.error?.message ?? `HTTP ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    const text = responsesApi
      ? body?.output
          ?.flatMap((item) => item.content ?? [])
          .filter((item) => item.type === "output_text" && item.text)
          .map((item) => item.text)
          .join("")
      : body?.choices?.[0]?.message?.content;
    if (!text) {
      this.emitTrace(trace, this.traceEvent(
        operation,
        "error",
        started,
        systemBytes,
        inputBytes,
        body,
      ));
      throw new ModelProviderError("No model output", true);
    }
    const truncated = responsesApi
      ? body?.incomplete_details?.reason === "max_output_tokens"
      : body?.choices?.[0]?.finish_reason === "length";
    if (truncated) {
      this.emitTrace(trace, this.traceEvent(
        operation,
        "error",
        started,
        systemBytes,
        inputBytes,
        body,
      ));
      throw new ModelProviderError("Model output truncated", true);
    }
    try {
      const result: unknown = JSON.parse(text);
      this.emitTrace(trace, this.traceEvent(
        operation,
        "success",
        started,
        systemBytes,
        inputBytes,
        body,
      ));
      return result;
    } catch {
      this.emitTrace(trace, this.traceEvent(
        operation,
        requireJson ? "error" : "success",
        started,
        systemBytes,
        inputBytes,
        body,
      ));
      if (requireJson)
        throw new ModelProviderError("Malformed model JSON", false);
      return text;
    }
  }

  private traceEvent(
    operation: ModelOperation,
    status: "success" | "error",
    started: number,
    systemBytes: number,
    inputBytes: number,
    body: ProviderResponseMetadata | null,
  ) {
    const usage = body?.usage;
    const finishReason = body?.choices?.[0]?.finish_reason
      ?? body?.incomplete_details?.reason
      ?? body?.status;
    return {
      operation,
      status,
      durationMs: Math.round(performance.now() - started),
      systemBytes,
      inputBytes,
      body,
      finishReason,
      usage,
    };
  }

  private emitTrace(
    trace: OperationalTraceContext | undefined,
    event: {
      operation: ModelOperation;
      status: "success" | "error";
      durationMs: number;
      systemBytes: number;
      inputBytes: number;
      body?: ProviderResponseMetadata | null;
      finishReason?: string;
      usage?: ProviderUsage;
    },
  ): void {
    if (!trace) return;
    const usage = event.usage ?? event.body?.usage;
    emitOperationalTrace(trace.sink, {
      kind: "model_call",
      requestId: trace.requestId,
      operation: event.operation,
      provider: this.name,
      configuredModel: this.o.model,
      ...(event.body?.model ? { resolvedModel: event.body.model } : {}),
      ...(event.body?.id ? { responseId: event.body.id } : {}),
      status: event.status,
      durationMs: event.durationMs,
      systemBytes: event.systemBytes,
      inputBytes: event.inputBytes,
      ...(event.finishReason ? { finishReason: event.finishReason } : {}),
      ...(usage?.prompt_tokens !== undefined || usage?.input_tokens !== undefined
        ? { inputTokens: usage.prompt_tokens ?? usage.input_tokens }
        : {}),
      ...(usage?.prompt_tokens_details?.cached_tokens !== undefined
        || usage?.input_tokens_details?.cached_tokens !== undefined
        ? {
            cachedInputTokens: usage.prompt_tokens_details?.cached_tokens
              ?? usage.input_tokens_details?.cached_tokens,
          }
        : {}),
      ...(usage?.completion_tokens !== undefined || usage?.output_tokens !== undefined
        ? { outputTokens: usage.completion_tokens ?? usage.output_tokens }
        : {}),
      ...(usage?.completion_tokens_details?.reasoning_tokens !== undefined
        || usage?.output_tokens_details?.reasoning_tokens !== undefined
        ? {
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens
              ?? usage.output_tokens_details?.reasoning_tokens,
          }
        : {}),
      ...(usage?.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    });
  }
}

interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface ProviderResponseMetadata {
  id?: string;
  model?: string;
  choices?: { finish_reason?: string }[];
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: ProviderUsage;
}
