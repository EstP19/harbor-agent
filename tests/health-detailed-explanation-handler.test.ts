import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDetailedExplanationRequestHash,
  PostgresDetailedExplanationReservation,
} from '../agent/capabilities/health-detailed-explanation/reservation.ts';
import { verifyHealthServiceAuthorization } from '../agent/capabilities/health-detailed-explanation/service-auth.ts';
import { createDetailedExplanationHandler } from '../agent/capabilities/health-detailed-explanation/handler.ts';
import { handleDetailedExplanationHttpRequest } from '../agent/capabilities/health-detailed-explanation/route.ts';
import type { DetailedExplanationCapsule } from '../agent/capabilities/health-detailed-explanation/schema.ts';

const groundedWords = ['approved', 'capsule', 'body', 'must', 'never', 'enter', 'evidence', 'or', 'logs'];
const prose = (wordCount: number) =>
  Array.from({ length: wordCount }, (_, index) => groundedWords[index % groundedWords.length]).join(' ');

function capsule(): DetailedExplanationCapsule {
  return {
    contractVersion: 'health-detailed-explanation/v1',
    outputSchemaVersion: 'health-detailed-explanation-output/v1',
    idempotencyKey: 'idem-opaque-1',
    requestId: 'request-opaque-1',
    itemId: 'item-opaque-1',
    conceptCode: 'LOINC:718-7',
    displayName: 'Hemoglobin',
    languageCode: 'en' as const,
    level: 'L1' as const,
    approvedContentBlocks: [{
      contentBlockId: 'block-opaque-1',
      contentVersionId: 'content-version-opaque-1',
      contentHash: 'sha256:approved-content',
      text: `${prose(118)}. role. measurement.`,
    }],
    approvedSources: [{
      sourceRef: 'source-opaque-1',
      sourceVersionId: 'source-version-opaque-1',
      sourceContentHash: 'sha256:approved-source',
    }],
  };
}

function output() {
  return {
    contractVersion: 'health-detailed-explanation/v1',
    outputSchemaVersion: 'health-detailed-explanation-output/v1',
    capabilityVersion: 'health-detailed-explanation-capability/v1',
    conceptCode: 'LOINC:718-7',
    languageCode: 'en',
    level: 'L1',
    summary: prose(118),
    biologicalRole: 'role',
    whyMeasured: 'measurement',
    generalConsiderations: [],
    measurementNotes: [],
    limitations: [],
    sourceRefs: [],
  };
}

function successReservation() {
  return { claim: async () => ({ kind: 'claimed' as const, claimToken: 'claim-opaque-1' }), finalize: async () => {} };
}

function clock(nowValues = [1000, 1025]) {
  let index = 0;
  return {
    now: () => nowValues[Math.min(index++, nowValues.length - 1)],
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
}

test('health detailed explanation handler returns only validated structured output and sanitized evidence', async () => {
  const evidence: unknown[] = [];
  const handler = createDetailedExplanationHandler({
    completion: async () => output(),
    reservation: successReservation(),
    clock: clock(),
    evidence: { record: async event => { evidence.push(event); } },
    timeoutMs: 10,
  });

  const result = await handler(capsule());

  assert.deepEqual(result, { ok: true, output: output() });
  assert.deepEqual(evidence, [{
    requestId: 'request-opaque-1',
    itemId: 'item-opaque-1',
    contractVersion: 'health-detailed-explanation/v1',
    capabilityVersion: 'health-detailed-explanation-capability/v1',
    status: 'completed',
    durationMs: 25,
  }]);
  const serializedEvidence = JSON.stringify(evidence);
  assert.equal(serializedEvidence.includes('Approved capsule body'), false);
  assert.equal(serializedEvidence.includes('Hemoglobin'), false);
  assert.equal(serializedEvidence.includes('generated1'), false);
});

test('health detailed explanation handler rejects malformed capsules without provider calls', async () => {
  let completionCalls = 0;
  const handler = createDetailedExplanationHandler({
    completion: async () => { completionCalls += 1; return output(); },
    reservation: successReservation(),
    clock: clock(),
    evidence: { record: async () => {} },
    timeoutMs: 10,
  });

  const result = await handler({ ...capsule(), subjectId: 'forbidden' });

  assert.deepEqual(result, { ok: false, code: 'DETAILED_EXPLANATION_REQUEST_REJECTED' });
  assert.equal(completionCalls, 0);
});

test('health detailed explanation handler converges duplicate reservations without another provider call', async () => {
  let completionCalls = 0;
  const handler = createDetailedExplanationHandler({
    completion: async () => { completionCalls += 1; return output(); },
    reservation: { claim: async () => ({ kind: 'duplicate' as const, status: 'running' as const }), finalize: async () => {} },
    clock: clock(),
    evidence: { record: async () => {} },
    timeoutMs: 10,
  });

  const result = await handler(capsule());

  assert.deepEqual(result, { ok: false, code: 'DETAILED_EXPLANATION_DUPLICATE' });
  assert.equal(completionCalls, 0);
});

test('health detailed explanation handler replays a completed validated output after a lost response without another provider call', async () => {
  let completionCalls = 0;
  let cachedOutput: unknown;
  let claimed = false;
  const handler = createDetailedExplanationHandler({
    completion: async () => { completionCalls += 1; return output(); },
    reservation: {
      claim: async () => claimed
        ? { kind: 'duplicate' as const, status: 'completed' as const, output: cachedOutput }
        : (claimed = true, { kind: 'claimed' as const, claimToken: 'claim-opaque-1' }),
      finalize: async input => { if (input.status === 'completed') cachedOutput = input.output; },
    },
    clock: clock(),
    evidence: { record: async () => {} },
    timeoutMs: 10,
  });

  assert.deepEqual(await handler(capsule()), { ok: true, output: output() });
  assert.deepEqual(await handler(capsule()), { ok: true, output: output() });
  assert.equal(completionCalls, 1);
});

test('health detailed explanation handler returns a stable conflict for a reused key with a different hash', async () => {
  let completionCalls = 0;
  const handler = createDetailedExplanationHandler({
    completion: async () => { completionCalls += 1; return output(); },
    reservation: { claim: async () => ({ kind: 'conflict' as const }), finalize: async () => {} },
    clock: clock(),
    evidence: { record: async () => {} },
    timeoutMs: 10,
  });

  const result = await handler(capsule());

  assert.deepEqual(result, { ok: false, code: 'DETAILED_EXPLANATION_IDEMPOTENCY_CONFLICT' });
  assert.equal(completionCalls, 0);
});

test('health detailed explanation handler maps completion timeout and rejected output to stable failures', async () => {
  const timeoutClock = {
    now: () => 1000,
    setTimeout: (callback: () => void) => { queueMicrotask(callback); return 1; },
    clearTimeout: () => {},
  };
  const timeoutHandler = createDetailedExplanationHandler({
    completion: async (_prompt, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    reservation: successReservation(),
    clock: timeoutClock,
    evidence: { record: async () => {} },
    timeoutMs: 10,
  });
  const rejectedOutputHandler = createDetailedExplanationHandler({
    completion: async () => ({ unexpected: 'provider response' }),
    reservation: successReservation(),
    clock: clock(),
    evidence: { record: async () => {} },
    timeoutMs: 10,
  });

  assert.deepEqual(await timeoutHandler(capsule()), {
    ok: false,
    code: 'DETAILED_EXPLANATION_TEMPORARY_FAILURE',
  });
  assert.deepEqual(await rejectedOutputHandler(capsule()), {
    ok: false,
    code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED',
  });
});

test('health detailed explanation reservation hashes canonical capsules and fails closed on database errors', async () => {
  const first = capsule();
  const reordered = {
    ...first,
    approvedContentBlocks: first.approvedContentBlocks.map(block => ({
      text: block.text,
      contentHash: block.contentHash,
      contentVersionId: block.contentVersionId,
      contentBlockId: block.contentBlockId,
    })),
  };
  assert.equal(createDetailedExplanationRequestHash(first), createDetailedExplanationRequestHash(reordered));

  const adapter = new PostgresDetailedExplanationReservation({ query: async () => { throw new Error('database unavailable'); } });
  await assert.rejects(() => adapter.claim({
    idempotencyKey: first.idempotencyKey,
    requestHash: createDetailedExplanationRequestHash(first),
  }), /database unavailable/);
});

test('health detailed explanation reservation translates atomic database outcomes', async () => {
  const requestHash = createDetailedExplanationRequestHash(capsule());
  const outcomes = [
    { outcome: 'claimed', claim_token: 'claim-1' },
    { outcome: 'duplicate', status: 'running' },
    { outcome: 'duplicate', status: 'completed', response_json: output() },
    { outcome: 'conflict' },
  ] as const;

  for (const expected of outcomes) {
    const adapter = new PostgresDetailedExplanationReservation({
      query: async () => ({ rows: [expected] }),
    });
    const result = await adapter.claim({ idempotencyKey: 'idem-opaque-1', requestHash });
    assert.equal(result.kind, expected.outcome);
    if ('status' in expected && expected.status === 'completed') assert.deepEqual(result, { kind: 'duplicate', status: 'completed', output: output() });
  }
});

test('health detailed explanation service authorization requires the configured constant-time bearer token', () => {
  assert.equal(verifyHealthServiceAuthorization(undefined, undefined), false);
  assert.equal(verifyHealthServiceAuthorization(undefined, 'service-secret'), false);
  assert.equal(verifyHealthServiceAuthorization('Bearer wrong-secret', 'service-secret'), false);
  assert.equal(verifyHealthServiceAuthorization('Basic service-secret', 'service-secret'), false);
  assert.equal(verifyHealthServiceAuthorization('Bearer service-secret', 'service-secret'), true);

  const configuredToken = process.env.HARBOR_HEALTH_SERVICE_TOKEN;
  delete process.env.HARBOR_HEALTH_SERVICE_TOKEN;
  try {
    assert.equal(verifyHealthServiceAuthorization('Bearer harbor-health-service-token-v1'), false);
    assert.equal(verifyHealthServiceAuthorization('Bearer fixture-health-service-authorization-token'), false);
  } finally {
    if (configuredToken === undefined) delete process.env.HARBOR_HEALTH_SERVICE_TOKEN;
    else process.env.HARBOR_HEALTH_SERVICE_TOKEN = configuredToken;
  }
});

test('health detailed explanation HTTP boundary requires service auth and returns stable strict responses', async () => {
  let handlerCalls = 0;
  const handler = async () => {
    handlerCalls += 1;
    return { ok: false as const, code: 'DETAILED_EXPLANATION_REQUEST_REJECTED' as const };
  };

  assert.deepEqual(await handleDetailedExplanationHttpRequest({
    authorization: undefined,
    bodyText: JSON.stringify(capsule()),
    serviceToken: 'service-secret',
    handler,
  }), {
    statusCode: 401,
    body: { ok: false, code: 'DETAILED_EXPLANATION_UNAUTHORIZED' },
  });
  assert.equal(handlerCalls, 0);

  assert.deepEqual(await handleDetailedExplanationHttpRequest({
    authorization: 'Bearer service-secret',
    bodyText: '{not-json}',
    serviceToken: 'service-secret',
    handler,
  }), {
    statusCode: 400,
    body: { ok: false, code: 'DETAILED_EXPLANATION_REQUEST_REJECTED' },
  });
  assert.equal(handlerCalls, 0);

  assert.deepEqual(await handleDetailedExplanationHttpRequest({
    authorization: 'Bearer service-secret',
    bodyText: JSON.stringify(capsule()),
    serviceToken: 'service-secret',
    handler,
  }), {
    statusCode: 400,
    body: { ok: false, code: 'DETAILED_EXPLANATION_REQUEST_REJECTED' },
  });
  assert.equal(handlerCalls, 1);
});
