import { isRecord } from "../../http";
import { ModelProviderError } from "../provider";
import type { PortableEffort, TkslopperArtifactEndpoint } from "./config";

type Outcome =
  | { kind: "complete"; text: string }
  | { kind: "truncated" }
  | { kind: "incomplete" }
  | { kind: "refused" }
  | { kind: "empty" };

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function firstChoice(body: Record<string, unknown>): Record<string, unknown> {
  return record(Array.isArray(body.choices) ? body.choices[0] : undefined);
}

/** A Responses result is complete only when every condition holds. */
export function responsesOutcome(body: Record<string, unknown>): Outcome {
  const output: unknown[] = Array.isArray(body.output) ? body.output : [];
  const parts = output
    .filter(isRecord)
    .filter((item) => item.type === "message")
    .flatMap((item): unknown[] => (Array.isArray(item.content) ? item.content : []))
    .filter(isRecord);
  if (parts.some((part) => part.type === "refusal")) return { kind: "refused" };
  if (body.status === "incomplete") {
    return record(body.incomplete_details).reason === "max_output_tokens"
      ? { kind: "truncated" }
      : { kind: "incomplete" };
  }
  if (body.status !== "completed") return { kind: "incomplete" };
  const text = parts
    .map((part) =>
      part.type === "output_text" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
  return text ? { kind: "complete", text } : { kind: "empty" };
}

/** A Chat result is complete only when it stopped with non-empty content. */
export function chatOutcome(body: Record<string, unknown>): Outcome {
  const choice = firstChoice(body);
  const message = record(choice.message);
  const finishReason = choice.finish_reason;
  if (finishReason === "content_filter") return { kind: "refused" };
  if (typeof message.refusal === "string" && message.refusal)
    return { kind: "refused" };
  if (finishReason === "length") return { kind: "truncated" };
  if (finishReason !== "stop") return { kind: "incomplete" };
  return typeof message.content === "string" && message.content
    ? { kind: "complete", text: message.content }
    : { kind: "empty" };
}

export function outcomeError(
  outcome: Exclude<Outcome, { kind: "complete" }>,
): ModelProviderError {
  switch (outcome.kind) {
    case "truncated":
      return new ModelProviderError("Model output truncated", true);
    case "incomplete":
      return new ModelProviderError("Model output incomplete", true);
    case "refused":
      return new ModelProviderError("Model refused", false);
    case "empty":
      return new ModelProviderError("No model output", true);
  }
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function effortField(
  endpoint: TkslopperArtifactEndpoint,
  effort: PortableEffort | undefined,
): Record<string, unknown> {
  if (!effort) return {};
  return endpoint === "chat"
    ? { reasoning_effort: effort }
    : { reasoning: { effort } };
}
