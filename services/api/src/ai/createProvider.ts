import type { StudioEnv } from "../env";
import { FixtureModelProvider } from "./fixtureProvider";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider";
import type { ModelProvider } from "./provider";
import { ModelProviderError } from "./provider";

export interface ModelProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

class UnavailableModelProvider implements ModelProvider {
  readonly name = "unavailable";

  constructor(private readonly reason: string) {}

  generate(): Promise<never> {
    return Promise.reject(new ModelProviderError(this.reason, true));
  }

  revise(): Promise<never> {
    return Promise.reject(new ModelProviderError(this.reason, true));
  }

  repair(): Promise<never> {
    return Promise.reject(new ModelProviderError(this.reason, true));
  }

  moderate(): Promise<never> {
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

  if (provider === "openai-compatible") {
    return openAiCompatibleProvider(
      model,
      override?.baseUrl ?? env.AI_BASE_URL,
      override ? override.apiKey : env.AI_API_KEY,
      "openai-compatible",
      "AI_API_KEY",
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
      openCodeChatReasoningOptions(model),
    );
  }

  if (provider === "opencode-go") {
    return openAiCompatibleProvider(
      model,
      override?.baseUrl ?? "https://opencode.ai/zen/go/v1",
      override ? override.apiKey : env.OPENCODE_API_KEY,
      "opencode-go",
      "OPENCODE_API_KEY",
      undefined,
      model === "muse-spark-1.2-contributor"
        ? { reasoning: { effort: "xhigh" } }
        : openCodeChatReasoningOptions(model),
      model === "muse-spark-1.2-contributor"
        ? "responses"
        : "chat-completions",
      model === "muse-spark-1.2-contributor"
        ? { reasoning: { effort: "minimal" } }
        : undefined,
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
        reasoning: { effort: "xhigh", exclude: true },
      },
    );
  }

  return new UnavailableModelProvider(
    `Unsupported AI provider: ${provider}`,
  );
}

function openCodeChatReasoningOptions(
  model: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!model.startsWith("deepseek-")) return undefined;
  return {
    thinking: { type: "enabled" },
    reasoning_effort: "max",
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
  });
}
