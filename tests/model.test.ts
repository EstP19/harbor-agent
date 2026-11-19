import assert from "node:assert/strict";
import test from "node:test";

import { resolveModelForStep } from "../agent/model.ts";

test("returns a Gateway model ID for the gateway route", () => {
  const model = resolveModelForStep({
    AI_PROVIDER: "gateway",
    AI_MODEL: "gpt-5.6-terra",
    AI_GATEWAY_API_KEY: "test-gateway-key",
  });

  assert.equal(model, "openai/gpt-5.6-terra");
});

test("creates an OpenAI language model without making a request", () => {
  const model = resolveModelForStep({
    AI_PROVIDER: "openai",
    AI_MODEL: "gpt-5.6-terra",
    OPENAI_API_KEY: "test-openai-key",
  });

  assert.notEqual(typeof model, "string");
  if (typeof model !== "string") {
    assert.equal(model.modelId, "gpt-5.6-terra");
  }
});
