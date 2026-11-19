import { openai } from "@ai-sdk/openai";

import { selectModel } from "./model-config.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export function resolveModelForStep(environment: Environment = process.env) {
  return selectModel(environment, (modelId) => openai(modelId));
}
