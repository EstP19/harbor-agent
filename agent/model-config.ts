export const DEFAULT_AI_PROVIDER = "openai" as const;
export const DEFAULT_AI_MODEL = "gpt-4o-mini";

type Environment = Readonly<Record<string, string | undefined>>;

export type GatewayModelId = `openai/${string}`;

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

export function selectModel<T>(
  environment: Environment,
  createOpenAIModel: (modelId: string) => T,
): T | GatewayModelId {
  const provider =
    environment.AI_PROVIDER === undefined
      ? DEFAULT_AI_PROVIDER
      : environment.AI_PROVIDER.trim();
  const modelId =
    environment.AI_MODEL === undefined
      ? DEFAULT_AI_MODEL
      : environment.AI_MODEL.trim();

  if (provider !== "openai" && provider !== "gateway") {
    throw new Error('AI_PROVIDER must be "openai" or "gateway".');
  }

  if (modelId.length === 0 || modelId.includes("/")) {
    throw new Error(
      "AI_MODEL must be a non-empty, unprefixed OpenAI model ID.",
    );
  }

  if (provider === "openai") {
    if (!hasValue(environment.OPENAI_API_KEY)) {
      throw new Error(
        "OPENAI_API_KEY is required when AI_PROVIDER=openai.",
      );
    }

    return createOpenAIModel(modelId);
  }

  if (
    !hasValue(environment.AI_GATEWAY_API_KEY) &&
    !hasValue(environment.VERCEL_OIDC_TOKEN)
  ) {
    throw new Error(
      "AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required when AI_PROVIDER=gateway.",
    );
  }

  return `openai/${modelId}`;
}
