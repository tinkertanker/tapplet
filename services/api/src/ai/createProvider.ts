import type { StudioEnv } from "../env";
import { FixtureModelProvider } from "./fixtureProvider";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider";
import type { ModelProvider } from "./provider";
import { ModelProviderError } from "./provider";

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

export function createModelProvider(env: StudioEnv): ModelProvider {
  if (env.AI_PROVIDER === "fixture") return new FixtureModelProvider();

  if (env.AI_PROVIDER === "openai-compatible") {
    return openAiCompatibleProvider(
      env,
      env.AI_BASE_URL,
      env.AI_API_KEY,
      "openai-compatible",
      "AI_API_KEY",
    );
  }

  if (env.AI_PROVIDER === "opencode") {
    return openAiCompatibleProvider(
      env,
      "https://opencode.ai/zen/v1",
      env.OPENCODE_API_KEY,
      "opencode",
      "OPENCODE_API_KEY",
      undefined,
      openCodeChatReasoningOptions(env.AI_MODEL),
    );
  }

  if (env.AI_PROVIDER === "opencode-go") {
    return openAiCompatibleProvider(
      env,
      "https://opencode.ai/zen/go/v1",
      env.OPENCODE_API_KEY,
      "opencode-go",
      "OPENCODE_API_KEY",
      undefined,
      env.AI_MODEL === "muse-spark-1.2-contributor"
        ? { reasoning: { effort: "xhigh" } }
        : openCodeChatReasoningOptions(env.AI_MODEL),
      env.AI_MODEL === "muse-spark-1.2-contributor"
        ? "responses"
        : "chat-completions",
      env.AI_MODEL === "muse-spark-1.2-contributor"
        ? { reasoning: { effort: "minimal" } }
        : undefined,
    );
  }

  if (env.AI_PROVIDER === "openrouter") {
    return openAiCompatibleProvider(
      env,
      "https://openrouter.ai/api/v1",
      env.OPENROUTER_API_KEY,
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
    `Unsupported AI provider: ${env.AI_PROVIDER}`,
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
  env: StudioEnv,
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
    model: env.AI_MODEL,
    ...(api ? { api } : {}),
    providerName,
    ...(headers ? { headers } : {}),
    ...(reasoningOptions ? { reasoningOptions } : {}),
    ...(moderationReasoningOptions ? { moderationReasoningOptions } : {}),
  });
}
