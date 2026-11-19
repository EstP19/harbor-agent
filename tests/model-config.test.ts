import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  selectModel,
} from "../agent/model-config.ts";

const directModel = { kind: "direct-model" } as const;
const createDirectModel = (modelId: string) => ({ ...directModel, modelId });

test("defaults to direct OpenAI with gpt-4o-mini", () => {
  const result = selectModel(
    { OPENAI_API_KEY: "test-openai-key" },
    createDirectModel,
  );

  assert.equal(DEFAULT_AI_PROVIDER, "openai");
  assert.equal(DEFAULT_AI_MODEL, "gpt-4o-mini");
  assert.deepEqual(result, {
    kind: "direct-model",
    modelId: "gpt-4o-mini",
  });
});

test("uses a custom direct OpenAI model", () => {
  const result = selectModel(
    {
      AI_PROVIDER: "openai",
      AI_MODEL: "gpt-4o",
      OPENAI_API_KEY: "test-openai-key",
    },
    createDirectModel,
  );

  assert.deepEqual(result, {
    kind: "direct-model",
    modelId: "gpt-4o",
  });
});

test("maps an OpenAI model to the Gateway creator/model format", () => {
  const result = selectModel(
    {
      AI_PROVIDER: "gateway",
      AI_MODEL: "gpt-4o-mini",
      AI_GATEWAY_API_KEY: "test-gateway-key",
    },
    createDirectModel,
  );

  assert.equal(result, "openai/gpt-4o-mini");
});

test("accepts Vercel OIDC as the Gateway credential", () => {
  const result = selectModel(
    {
      AI_PROVIDER: "gateway",
      AI_MODEL: "gpt-4o-mini",
      VERCEL_OIDC_TOKEN: "test-oidc-token",
    },
    createDirectModel,
  );

  assert.equal(result, "openai/gpt-4o-mini");
});

test("rejects an unsupported provider", () => {
  assert.throws(
    () =>
      selectModel(
        { AI_PROVIDER: "automatic", OPENAI_API_KEY: "test-openai-key" },
        createDirectModel,
      ),
    { message: 'AI_PROVIDER must be "openai" or "gateway".' },
  );
});

test("rejects empty and prefixed model IDs", () => {
  for (const modelId of ["", "   ", "openai/gpt-4o-mini"]) {
    assert.throws(
      () =>
        selectModel(
          {
            AI_PROVIDER: "openai",
            AI_MODEL: modelId,
            OPENAI_API_KEY: "test-openai-key",
          },
          createDirectModel,
        ),
      {
        message:
          "AI_MODEL must be a non-empty, unprefixed OpenAI model ID.",
      },
    );
  }
});

test("requires the credential for the selected provider", () => {
  assert.throws(
    () => selectModel({ AI_PROVIDER: "openai" }, createDirectModel),
    { message: "OPENAI_API_KEY is required when AI_PROVIDER=openai." },
  );

  assert.throws(
    () => selectModel({ AI_PROVIDER: "gateway" }, createDirectModel),
    {
      message:
        "AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required when AI_PROVIDER=gateway.",
    },
  );
});

test("does not expose configured secrets in validation errors", () => {
  assert.throws(
    () =>
      selectModel(
        {
          AI_PROVIDER: "invalid",
          OPENAI_API_KEY: "secret-key-that-must-not-leak",
        },
        createDirectModel,
      ),
    (error: unknown) => {
      assert(error instanceof Error);
      assert(!error.message.includes("secret-key-that-must-not-leak"));
      return true;
    },
  );
});
