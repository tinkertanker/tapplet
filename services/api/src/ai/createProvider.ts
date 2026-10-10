import type { StudioEnv } from "../env";
import { AnthropicProvider } from "./anthropicProvider";
import { FixtureModelProvider } from "./fixtureProvider";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider";
import type { PromptBoundaryMode } from "./prompts";
import type { ModelProvider } from "./provider";
import { ModelProviderError } from "./provider";

export interface ModelProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  reasoningEffort?: ReasoningEffort;
  promptBoundaryMode?: PromptBoundaryMode;
}

export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "max"
  | "xhigh";

export class UnavailableModelProvider implements ModelProvider {
  readonly name = "unavailable";

  constructor(private readonly reason: string) {}

  generate(): Promise<never> {
    return this.unavailable();
  }

  revise(): Promise<never> {
    return this.unavailable();
  }

  repair(): Promise<never> {
    return this.unavailable();
  }

  moderate(): Promise<never> {
    return this.unavailable();
  }

  // The API maps this to a generic 503, so the reason is logged here for
  // operators; it names configuration keys, never their values.
  private unavailable(): Promise<never> {
    console.error(`Model provider unavailable: ${this.reason}`);
    return Promise.reject(new ModelProviderError(this.reason, true));
  }
}

export function createModelProvider(
  env: StudioEnv,
  override?: ModelProviderConfig,
): ModelProvider {
  const provider = override?.provider ?? env.AI_PROVIDER,
    model = override?.model ?? env.AI_MODEL;
  if (provider === "fixture") return new FixtureModelProvider();

  if (provider === "anthropic") {
    const apiKey = override ? override.apiKey : env.ANTHROPIC_API_KEY;
    if (!apiKey) return new UnavailableModelProvider("The configured model provider has no ANTHROPIC_API_KEY.");
    const effort = override?.reasoningEffort;
    if (effort && !["low", "medium", "high"].includes(effort))
      return new UnavailableModelProvider("Anthropic reasoning effort must be low, medium or high.");
    return new AnthropicProvider({
      apiKey,
      model: model || "claude-haiku-5-5",
      baseUrl: override?.baseUrl ?? "https://api.anthropic.com/v1",
      effort: effort as "low" | "medium" | "high" | undefined,
      promptBoundaryMode: override?.promptBoundaryMode,
    });
  }

  if (provider === "openai-compatible") {
    const baseUrl = override?.baseUrl ?? env.AI_BASE_URL;
    // Keep older models and third-party compatible endpoints on their existing dialect.
    const openAi = new URL(baseUrl).hostname === "api.openai.com"
      && (!model || /^gpt-[56](?:[.-]|$)/.test(model));
    return openAiCompatibleProvider(
      model || (openAi ? "gpt-6-luna" : model),
      baseUrl,
      override ? override.apiKey : env.AI_API_KEY,
      "openai-compatible",
      "AI_API_KEY",
      undefined,
      openAi
        ? { reasoning: { effort: override?.reasoningEffort ?? "medium" } }
        : openAiCompatibleReasoningOptions(baseUrl, override?.reasoningEffort),
      openAi ? "responses" : undefined,
      openAi ? { reasoning: { effort: "low" } } : undefined,
      override?.promptBoundaryMode,
    );
  }

  if (provider === "opencode") {
    return openAiCompatibleProvider(
      model,
      override?.baseUrl ?? "https://opencode.ai/zen/v1",
      override ? override.apiKey : env.OPENCODE_API_KEY,
      "opencode",
      "OPENCODE_API_KEY",
      undefined,
      openCodeChatReasoningOptions(model, override?.reasoningEffort),
      undefined,
      undefined,
      override?.promptBoundaryMode,
    );
  }

  if (provider === "opencode-go") {
    const responses = openCodeGoResponsesFamily(model);
    return openAiCompatibleProvider(
      model,
      override?.baseUrl ?? "https://opencode.ai/zen/go/v1",
      override ? override.apiKey : env.OPENCODE_API_KEY,
      "opencode-go",
      "OPENCODE_API_KEY",
      undefined,
      responses
        ? { reasoning: { effort: override?.reasoningEffort ?? responses.effort } }
        : openCodeChatReasoningOptions(model, override?.reasoningEffort),
      responses ? "responses" : "chat-completions",
      responses
        ? { reasoning: { effort: responses.moderationEffort } }
        : undefined,
      override?.promptBoundaryMode,
    );
  }

  if (provider === "openrouter") {
    return openAiCompatibleProvider(
      model,
      override?.baseUrl ?? "https://openrouter.ai/api/v1",
      override ? override.apiKey : env.OPENROUTER_API_KEY,
      "openrouter",
      "OPENROUTER_API_KEY",
      {
        "HTTP-Referer": env.PUBLIC_PLAYER_ORIGIN,
        "X-OpenRouter-Title": "Tapplet Studio",
      },
      {
        reasoning: { effort: override?.reasoningEffort ?? "xhigh", exclude: true },
      },
      undefined,
      undefined,
      override?.promptBoundaryMode,
    );
  }

  return new UnavailableModelProvider(
    `Unsupported AI provider: ${provider}`,
  );
}

interface OpenCodeGoResponsesFamily {
  pattern: RegExp;
  effort: ReasoningEffort;
  moderationEffort: ReasoningEffort;
}

// OpenCode Go serves these model families only through the Responses API;
// every other Go model uses chat completions. Match families, not exact IDs,
// so a new version (for example muse-spark-1.3-contributor) keeps its dialect.
const OPENCODE_GO_RESPONSES_FAMILIES: readonly OpenCodeGoResponsesFamily[] = [
  { pattern: /^muse-spark-/, effort: "xhigh", moderationEffort: "minimal" },
  { pattern: /^gpt-[56](?:[.-]|$)/, effort: "medium", moderationEffort: "low" },
];

function openCodeGoResponsesFamily(
  model: string,
): OpenCodeGoResponsesFamily | undefined {
  return OPENCODE_GO_RESPONSES_FAMILIES.find(({ pattern }) => pattern.test(model));
}

function openAiCompatibleReasoningOptions(
  baseUrl: string,
  effort?: ReasoningEffort,
): Readonly<Record<string, unknown>> | undefined {
  if (!effort) return undefined;
  return {
    ...(new URL(baseUrl).hostname === "api.deepseek.com"
      ? { thinking: { type: "enabled" } }
      : {}),
    reasoning_effort: effort,
  };
}

function openCodeChatReasoningOptions(
  model: string,
  effort?: ReasoningEffort,
): Readonly<Record<string, unknown>> | undefined {
  if (!model.startsWith("deepseek-") && !effort) return undefined;
  return {
    thinking: { type: "enabled" },
    reasoning_effort: effort ?? "max",
  };
}

function openAiCompatibleProvider(
  model: string,
  baseUrl: string,
  apiKey: string | undefined,
  providerName: string,
  apiKeyName: string,
  headers?: Readonly<Record<string, string>>,
  reasoningOptions?: Readonly<Record<string, unknown>>,
  api?: "chat-completions" | "responses",
  moderationReasoningOptions?: Readonly<Record<string, unknown>>,
  promptBoundaryMode?: PromptBoundaryMode,
): ModelProvider {
  if (!apiKey) {
    return new UnavailableModelProvider(
      `The configured model provider has no ${apiKeyName}.`,
    );
  }
  return new OpenAiCompatibleProvider({
    baseUrl,
    apiKey,
    model,
    ...(api ? { api } : {}),
    providerName,
    ...(headers ? { headers } : {}),
    ...(reasoningOptions ? { reasoningOptions } : {}),
    ...(moderationReasoningOptions ? { moderationReasoningOptions } : {}),
    ...(promptBoundaryMode ? { promptBoundaryMode } : {}),
  });
}
