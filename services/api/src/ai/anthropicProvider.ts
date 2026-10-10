import {
  ARTIFACT_OUTPUT_SCHEMA,
  generationPrompt,
  MODERATION_OUTPUT_SCHEMA,
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
import { MODEL_CALL_TIMEOUT_MS, ModelProviderError } from "./provider";
import { emitOperationalTrace } from "../operationalTrace";
import type {
  ModelOperation,
  OperationalTraceContext,
} from "../operationalTrace";

interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  effort?: "low" | "medium" | "high";
  promptBoundaryMode?: PromptBoundaryMode;
}

interface MessageResponse {
  id?: string;
  model?: string;
  stop_reason?: string;
  content?: { type: string; text?: string }[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Native, server-side BYOK only. Managed credentials never reach this adapter. */
export class AnthropicProvider implements ModelProvider {
  readonly name: string;
  constructor(private readonly options: AnthropicProviderOptions) {
    this.name = `anthropic:${options.model}`;
  }

  generate(
    brief: TeacherBrief,
    exemplars: Exemplar[],
    trace?: OperationalTraceContext,
  ) {
    return this.complete(
      "generate",
      generationPrompt(brief, exemplars, this.options.promptBoundaryMode),
      trace,
    );
  }

  revise(
    html: string,
    card: DesignCard | undefined,
    instruction: string,
    brief: TeacherBrief,
    trace?: OperationalTraceContext,
  ) {
    return this.complete(
      "revise",
      revisionPrompt(
        html,
        card,
        instruction,
        brief,
        this.options.promptBoundaryMode,
      ),
      trace,
    );
  }

  repair(
    candidate: unknown,
    issues: string[],
    context?: RepairContext,
    trace?: OperationalTraceContext,
  ) {
    return this.complete(
      "repair",
      repairPrompt(candidate, issues, context, this.options.promptBoundaryMode),
      trace,
    );
  }

  async moderate(
    html: string,
    trace?: OperationalTraceContext,
  ): Promise<ModerationDecision> {
    const result = await this.complete("moderate", html, trace);
    if (
      !result ||
      typeof result !== "object" ||
      typeof Reflect.get(result, "safe") !== "boolean" ||
      !Array.isArray(Reflect.get(result, "categories")) ||
      !(Reflect.get(result, "categories") as unknown[]).every(
        (item) => typeof item === "string",
      )
    ) {
      throw new ModelProviderError("Invalid moderation response", true);
    }
    return {
      safe: Reflect.get(result, "safe") as boolean,
      categories: Reflect.get(result, "categories") as string[],
    };
  }

  private async complete(
    operation: ModelOperation,
    user: string,
    trace?: OperationalTraceContext,
  ): Promise<unknown> {
    const moderation = operation === "moderate";
    const system = moderation ? MODERATION_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const started = performance.now();
    let body: MessageResponse | null = null;
    let status: "success" | "error" = "error";
    try {
      const response = await fetch(
        `${this.options.baseUrl.replace(/\/$/, "")}/messages`,
        {
          method: "POST",
          // Custom API-key headers must never follow a redirect to another endpoint.
          redirect: "manual",
          headers: {
            "x-api-key": this.options.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.options.model,
            system,
            messages: [{ role: "user", content: user }],
            max_tokens: moderation ? 4096 : 32000,
            stream: false,
            thinking: { type: "adaptive" },
            output_config: {
              effort: moderation ? "low" : (this.options.effort ?? "medium"),
              format: {
                type: "json_schema",
                schema: moderation
                  ? MODERATION_OUTPUT_SCHEMA
                  : ARTIFACT_OUTPUT_SCHEMA,
              },
            },
          }),
          signal: AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        // Provider error bodies may echo input or credentials; never propagate them.
        await response.body?.cancel();
        throw new ModelProviderError(
          `Anthropic HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }
      body = (await response.json()) as MessageResponse;
      if (body.stop_reason === "refusal")
        throw new ModelProviderError("Model refused the request", false);
      if (
        body.stop_reason === "max_tokens" ||
        body.stop_reason === "model_context_window_exceeded"
      )
        throw new ModelProviderError("Model output truncated", true);
      if (
        body.stop_reason !== "end_turn" &&
        body.stop_reason !== "stop_sequence"
      )
        throw new ModelProviderError("Model output incomplete", true);
      const text = body.content
        ?.filter(
          (part) => part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("");
      if (!text?.trim()) throw new ModelProviderError("No model output", true);
      let result: unknown;
      try {
        result = JSON.parse(text);
      } catch {
        throw new ModelProviderError("Malformed model JSON", false);
      }
      status = "success";
      return result;
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      throw new ModelProviderError("Anthropic request failed", true);
    } finally {
      if (trace) {
        const usage = body?.usage;
        const inputTokens = usage
          ? usage.input_tokens +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0)
          : undefined;
        emitOperationalTrace(trace.sink, {
          kind: "model_call",
          requestId: trace.requestId,
          operation,
          provider: this.name,
          configuredModel: this.options.model,
          ...(body?.model ? { resolvedModel: body.model } : {}),
          ...(body?.id ? { responseId: body.id } : {}),
          ...(body?.stop_reason ? { finishReason: body.stop_reason } : {}),
          status,
          durationMs: Math.round(performance.now() - started),
          systemBytes: new TextEncoder().encode(system).byteLength,
          inputBytes: new TextEncoder().encode(user).byteLength,
          ...(usage
            ? {
                inputTokens,
                outputTokens: usage.output_tokens,
                cachedInputTokens: usage.cache_read_input_tokens ?? 0,
                totalTokens: inputTokens! + usage.output_tokens,
              }
            : {}),
        });
      }
    }
  }
}
