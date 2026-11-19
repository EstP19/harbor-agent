import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDetailedExplanationCompletion } from '../agent/capabilities/health-detailed-explanation/completion.ts';
import { createDetailedExplanationHandler } from '../agent/capabilities/health-detailed-explanation/handler.ts';
import { PostgresDetailedExplanationReservation } from '../agent/capabilities/health-detailed-explanation/reservation.ts';
import { readDetailedExplanationBody } from '../agent/capabilities/health-detailed-explanation/route.ts';
import type { DetailedExplanationCapsule, DetailedExplanationOutput } from '../agent/capabilities/health-detailed-explanation/schema.ts';

const capsule: DetailedExplanationCapsule = {
  contractVersion: 'health-detailed-explanation/v1', outputSchemaVersion: 'health-detailed-explanation-output/v1',
  idempotencyKey: 'idem', requestId: 'request', itemId: 'item', conceptCode: 'code', displayName: 'Name', languageCode: 'en', level: 'L1',
  approvedContentBlocks: [{ contentBlockId: 'block', contentVersionId: 'version', contentHash: 'hash', text: `${'approved '.repeat(118).trim()}. role. measurement.` }], approvedSources: [],
};
const validOutput = {
  contractVersion: 'health-detailed-explanation/v1', outputSchemaVersion: 'health-detailed-explanation-output/v1', capabilityVersion: 'health-detailed-explanation-capability/v1',
  conceptCode: 'code', languageCode: 'en', level: 'L1', summary: Array.from({ length: 118 }, () => 'approved').join(' '), biologicalRole: 'role', whyMeasured: 'measurement', generalConsiderations: [], measurementNotes: [], limitations: [], sourceRefs: [],
} satisfies DetailedExplanationOutput;
const clock = { now: () => 1, setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay), clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>) };

test('health detailed explanation completion never logs malformed generated fragments or upstream bodies', async () => {
  const logs: string[] = [];
  const completion = createDetailedExplanationCompletion({
    apiKey: 'api-key', model: 'safe-model', logger: { warn: message => { logs.push(message); } },
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{malformed generated secret}' } }] }), { status: 200 }),
  });
  await assert.rejects(() => completion({ systemPrompt: 'safe system', userPrompt: 'safe user' }));
  const upstream = createDetailedExplanationCompletion({
    apiKey: 'api-key', model: 'safe-model', logger: { warn: message => { logs.push(message); } },
    fetch: async () => new Response('upstream raw body secret', { status: 502 }),
  });
  await assert.rejects(() => upstream({ systemPrompt: 'safe system', userPrompt: 'safe user' }));
  assert.equal(JSON.stringify(logs).includes('generated secret'), false);
  assert.equal(JSON.stringify(logs).includes('upstream raw body secret'), false);
});

test('health detailed explanation completion fails closed without provider credentials', async () => {
  const logs: string[] = [];
  const completion = createDetailedExplanationCompletion({
    apiKey: undefined,
    model: 'safe-model',
    logger: { warn: message => { logs.push(message); } },
    fetch: async () => { throw new Error('fetch must not run'); },
  });

  await assert.rejects(
    () => completion({ systemPrompt: 'safe system', userPrompt: JSON.stringify(capsule) }),
    /completion unavailable/,
  );
  assert.deepEqual(logs, ['detailed explanation provider request failed']);
});

test('health detailed explanation handler never logs raw reservation failures', async () => {
  const logs: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const handler = createDetailedExplanationHandler({
      completion: async () => validOutput,
      reservation: {
        claim: async () => { throw new Error('generated prose secret'); },
        finalize: async () => {},
      },
      clock,
      timeoutMs: 100,
      evidence: { record: async () => {} },
    });

    assert.deepEqual(await handler(capsule), {
      ok: false,
      code: 'DETAILED_EXPLANATION_TEMPORARY_FAILURE',
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(logs, []);
});

test('health detailed explanation reservation emits dedicated atomic lifecycle SQL without sessions or requests', async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const adapter = new PostgresDetailedExplanationReservation({
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: calls.length === 1 ? [{ outcome: 'claimed', claim_token: 'claim-1' }] : [{ finalized: true }] };
    },
  });
  assert.deepEqual(await adapter.claim({ idempotencyKey: 'same-key', requestHash: 'hash' }), { kind: 'claimed', claimToken: 'claim-1' });
  await adapter.finalize({ idempotencyKey: 'same-key', requestHash: 'hash', claimToken: 'claim-1', status: 'completed', output: validOutput });
  assert.equal(calls[0].text.includes('agent_core.claim_capability_reservation'), true);
  assert.equal(/agent_core\.(sessions|requests)/.test(calls[0].text), false);
  assert.equal(calls[1].text.includes('agent_core.finalize_capability_reservation'), true);
  assert.deepEqual(calls[1].values[5], validOutput);
});

test('health detailed explanation handler finalizes completed, failed, and rejected claims while duplicate claims call no provider', async () => {
  for (const scenario of [
    { completion: async () => validOutput, evidenceFails: false, expected: 'completed' },
    { completion: async () => { throw new Error('provider raw failure'); }, evidenceFails: false, expected: 'failed' },
    { completion: async () => ({ wrong: 'generated raw fragment' }), evidenceFails: false, expected: 'rejected' },
    { completion: async () => validOutput, evidenceFails: true, expected: 'completed' },
  ] as const) {
    const finalized: string[] = [];
    const handler = createDetailedExplanationHandler({
      completion: scenario.completion,
      reservation: { claim: async () => ({ kind: 'claimed' as const, claimToken: 'claim' }), finalize: async input => { finalized.push(input.status); } },
      clock, timeoutMs: 100, evidence: { record: async () => { if (scenario.evidenceFails) throw new Error('evidence fail'); } },
    });
    await handler(capsule);
    assert.deepEqual(finalized, [scenario.expected]);
  }
  let providerCalls = 0;
  const duplicate = createDetailedExplanationHandler({
    completion: async () => { providerCalls += 1; return validOutput; },
    reservation: { claim: async () => ({ kind: 'duplicate' as const, status: 'completed' as const, output: validOutput }), finalize: async () => {} },
    clock, timeoutMs: 100, evidence: { record: async () => {} },
  });
  assert.deepEqual(await duplicate(capsule), { ok: true, output: validOutput });
  assert.equal(providerCalls, 0);
});

test('health detailed explanation timeout aborts and settles before releasing the claim', async () => {
  let aborted = false;
  const finalization: string[] = [];
  const immediateClock = { now: () => 1, setTimeout: (fn: () => void) => { queueMicrotask(fn); return 1; }, clearTimeout: () => {} };
  const handler = createDetailedExplanationHandler({
    completion: async (_prompt, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); })),
    reservation: { claim: async () => ({ kind: 'claimed' as const, claimToken: 'claim' }), finalize: async input => { assert.equal(aborted, true); finalization.push(input.status); } },
    clock: immediateClock, timeoutMs: 1, evidence: { record: async () => {} },
  });
  await handler(capsule);
  assert.equal(aborted, true);
  assert.deepEqual(finalization, ['failed']);
});

test('health detailed explanation body reader bounds and sanitizes stream failures', async () => {
  assert.deepEqual(await readDetailedExplanationBody((async function* () { yield Buffer.alloc(8); })(), 4), { ok: false, code: 'DETAILED_EXPLANATION_PAYLOAD_TOO_LARGE' });
  assert.deepEqual(await readDetailedExplanationBody((async function* () { throw new Error('stream secret'); })(), 4), { ok: false, code: 'DETAILED_EXPLANATION_REQUEST_BODY_ERROR' });
});
