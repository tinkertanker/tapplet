import type { StudioEnv } from "../../env";
import type { ModelOperation, OperationalTraceContext } from "../../operationalTrace";
import { emitOperationalTrace } from "../../operationalTrace";
import { UnavailableModelProvider } from "../createProvider";
import { ARTIFACT_OUTPUT_SCHEMA, generationPrompt, MODERATION_OUTPUT_SCHEMA, MODERATION_SYSTEM_PROMPT, repairPrompt, revisionPrompt, SYSTEM_PROMPT } from "../prompts";
import type { DesignCard, Exemplar, ModelProvider, ModerationDecision, RepairContext, TeacherBrief } from "../provider";
import { ModelProviderError, parseModerationDecision } from "../provider";
import { readTkslopperConfig } from "./config";
import type { TkslopperArtifactEndpoint, TkslopperClientConfig } from "./config";
import { TkslopperClient, TkslopperError } from "./client";
import type { TkslopperClientOptions, TkslopperGatewayResult } from "./client";
import { chatOutcome, effortField, firstChoice, numberOrUndefined, outcomeError, record, responsesOutcome, stringOrUndefined } from "./outcome";

const ARTIFACT_MAX_OUTPUT_TOKENS = 32_000;
export const REVIEW_MAX_OUTPUT_TOKENS = 500;

export interface TkslopperModelProviderOptions extends TkslopperClientOptions {
  client?: TkslopperClient;
}

export class TkslopperModelProvider implements ModelProvider {
  readonly name: string;
  private readonly client: TkslopperClient;

  constructor(
    private readonly config: TkslopperClientConfig,
    options: TkslopperModelProviderOptions = {},
  ) {
    this.name = `tkslopper:${config.artifactAlias}`;
    this.client = options.client ?? new TkslopperClient(config, options);
  }

  generate(b: TeacherBrief, e: Exemplar[], trace?: OperationalTraceContext) {
    return this.artifact("generate", generationPrompt(b, e), trace);
  }

  revise(
    h: string,
    c: DesignCard | undefined,
    i: string,
    b: TeacherBrief,
    trace?: OperationalTraceContext,
  ) {
    return this.artifact("revise", revisionPrompt(h, c, i, b), trace);
  }

  repair(
    c: unknown,
    i: string[],
    context?: RepairContext,
    trace?: OperationalTraceContext,
  ) {
    return this.artifact("repair", repairPrompt(c, i, context), trace);
  }

  async moderate(
    html: string,
    trace?: OperationalTraceContext,
  ): Promise<ModerationDecision> {
    const r = await this.complete(
      "moderate",
      "responses",
      MODERATION_SYSTEM_PROMPT,
      html,
      {
        model: this.config.reviewAlias,
        instructions: MODERATION_SYSTEM_PROMPT,
        input: html,
        text: { format: { type: "json_schema", name: "moderation", strict: true, schema: MODERATION_OUTPUT_SCHEMA } },
        max_output_tokens: REVIEW_MAX_OUTPUT_TOKENS,
        ...effortField("responses", this.config.reviewEffort),
        stream: false,
      },
      true,
      trace,
    );
    return parseModerationDecision(r);
  }

  private artifact(
    operation: "generate" | "revise" | "repair",
    prompt: string,
    trace?: OperationalTraceContext,
  ): Promise<unknown> {
    const endpoint = this.config.artifactEndpoint;
    const body =
      endpoint === "chat"
        ? {
            model: this.config.artifactAlias,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: prompt },
            ],
            response_format: { type: "json_schema", json_schema: { name: "artifact", strict: true, schema: ARTIFACT_OUTPUT_SCHEMA } },
            max_tokens: ARTIFACT_MAX_OUTPUT_TOKENS,
            ...effortField("chat", this.config.artifactEffort),
            stream: false,
          }
        : {
            model: this.config.artifactAlias,
            instructions: SYSTEM_PROMPT,
            input: prompt,
            text: { format: { type: "json_schema", name: "artifact", strict: true, schema: ARTIFACT_OUTPUT_SCHEMA } },
            max_output_tokens: ARTIFACT_MAX_OUTPUT_TOKENS,
            ...effortField("responses", this.config.artifactEffort),
            stream: false,
          };
    return this.complete(
      operation,
      endpoint,
      SYSTEM_PROMPT,
      prompt,
      body,
      false,
      trace,
    );
  }

  private async complete(
    operation: ModelOperation,
    endpoint: TkslopperArtifactEndpoint,
    system: string,
    user: string,
    body: Readonly<Record<string, unknown>>,
    requireJson: boolean,
    trace?: OperationalTraceContext,
  ): Promise<unknown> {
    const started = performance.now();
    const encoder = new TextEncoder();
    const base = {
      operation,
      started,
      systemBytes: encoder.encode(system).byteLength,
      inputBytes: encoder.encode(user).byteLength,
    };
    let result: TkslopperGatewayResult;
    try {
      result = await this.client.request(
        endpoint === "chat" ? "/v1/chat/completions" : "/v1/responses",
        body,
        operation,
      );
    } catch (error) {
      this.emitTrace(trace, {
        ...base,
        status: "error",
        ...(error instanceof TkslopperError && error.gatewayRequestId
          ? { gatewayRequestId: error.gatewayRequestId }
          : {}),
      });
      throw error;
    }
    const responseBody = result.body;
    const outcome =
      endpoint === "chat"
        ? chatOutcome(responseBody)
        : responsesOutcome(responseBody);
    const metadata = {
      ...base,
      body: responseBody,
      endpoint,
      ...(result.gatewayRequestId
        ? { gatewayRequestId: result.gatewayRequestId }
        : {}),
    };
    if (outcome.kind !== "complete") {
      this.emitTrace(trace, { ...metadata, status: "error" });
      throw outcomeError(outcome);
    }
    try {
      const parsed: unknown = JSON.parse(outcome.text);
      this.emitTrace(trace, { ...metadata, status: "success" });
      return parsed;
    } catch {
      this.emitTrace(trace, {
        ...metadata,
        status: requireJson ? "error" : "success",
      });
      if (requireJson)
        throw new ModelProviderError("Malformed model JSON", false);
      return outcome.text;
    }
  }

  private emitTrace(
    trace: OperationalTraceContext | undefined,
    event: {
      operation: ModelOperation;
      status: "success" | "error";
      started: number;
      systemBytes: number;
      inputBytes: number;
      endpoint?: TkslopperArtifactEndpoint;
      body?: Record<string, unknown>;
      gatewayRequestId?: string;
    },
  ): void {
    if (!trace) return;
    const body = event.body;
    const chat = event.endpoint === "chat";
    const resolvedModel = stringOrUndefined(body?.model);
    const responseId = stringOrUndefined(body?.id);
    const finishReason = body
      ? chat
        ? stringOrUndefined(firstChoice(body).finish_reason)
        : stringOrUndefined(record(body.incomplete_details).reason) ??
          stringOrUndefined(body.status)
      : undefined;
    const usage = record(body?.usage);
    const inputTokens = numberOrUndefined(
      chat ? usage.prompt_tokens : usage.input_tokens,
    );
    const outputTokens = numberOrUndefined(
      chat ? usage.completion_tokens : usage.output_tokens,
    );
    const totalTokens = numberOrUndefined(usage.total_tokens);
    emitOperationalTrace(trace.sink, {
      kind: "model_call",
      requestId: trace.requestId,
      operation: event.operation,
      provider: this.name,
      configuredModel:
        event.operation === "moderate"
          ? this.config.reviewAlias
          : this.config.artifactAlias,
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(responseId ? { responseId } : {}),
      ...(event.gatewayRequestId
        ? { gatewayRequestId: event.gatewayRequestId }
        : {}),
      status: event.status,
      durationMs: Math.round(performance.now() - event.started),
      systemBytes: event.systemBytes,
      inputBytes: event.inputBytes,
      ...(finishReason ? { finishReason } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    });
  }
}

export function createTkslopperModelProvider(
  env: StudioEnv,
  options: TkslopperClientOptions = {},
): ModelProvider {
  const result = readTkslopperConfig(env);
  if (!result.ok) return new UnavailableModelProvider(result.reason);
  return new TkslopperModelProvider(result.config, options);
}
