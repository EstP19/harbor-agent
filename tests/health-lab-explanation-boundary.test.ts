import assert from 'node:assert/strict';
import test from 'node:test';

import { handleHealthLabExplanationRequest } from '../agent/capabilities/health-lab-explanation/handler.ts';
import { handleHealthLabExplanationHttpRequest } from '../agent/capabilities/health-lab-explanation/route.ts';

const valid = {
  contractVersion: 'health-lab-explanation/v1',
  evidence: {
    literalMarker: 'WBC', conceptCode: 'LAB_LEUKOCYTEN', numericValue: '9.69',
    unit: '10^9/L', printedFlag: 'HOOG',
    referenceRange: { lowerBound: '4.23', upperBound: '9.07', unit: '10^9/L' },
  },
  marker: 'Leukocyten',
  stateCode: 'HIGH',
  level: 'L3',
  blocks: { a: 'Blok A', b: 'Blok B', c: 'Blok C' },
  text: 'Blok A\n\nBlok B\n\nBlok C',
  guardrail: 'Geen diagnose.',
  sourcesText: 'LESA Laboratoriumdiagnostiek',
  approvedBy: 'Dr. Fixture (12345678901)',
  approvedAt: '2026-09-08',
  provenance: {
    countryCode: 'NL',
    kbVersion: 'v4.4',
    sourceSheet: '5. Uitlegteksten (leidend)',
    sourceRow: 106,
    fileHash: 'a'.repeat(64),
    artifactSha256: 'a'.repeat(64),
    sheetHash: 'b'.repeat(64),
    rowHash: 'c'.repeat(64),
    doctorName: 'Dr. Fixture',
    doctorRegistration: '12345678901',
    reviewedDate: '2026-09-08',
  },
};

const { evidence: _evidence, ...sealedValid } = valid;

test('Validator seals one clinical state and rejects an altered response', async () => {
  const sections = ['Verhoogd'].map((label, index) => ({
    label, stateCode: 'NO_BAND', blocks: { a: `N1 ${label}` }, text: `N1 ${label}`,
    guardrail: valid.guardrail, sourcesText: valid.sourcesText, approvedBy: valid.approvedBy, approvedAt: valid.approvedAt,
    provenance: { ...valid.provenance, sourceRow: 10 + index },
  }));
  const a = sections.map(section => `## ${section.label}\n\n${section.text}`).join('\n\n');
  const input = { ...valid, sourceType: 'clinical_source', harborId: 'HH_CRP', stateCode: 'NO_BAND',
    level: 'L1', sections, blocks: { a }, text: a, provenance: sections[0].provenance };
  assert.equal((await handleHealthLabExplanationRequest(input)).ok, true);
  assert.equal((await handleHealthLabExplanationRequest({ ...input, sections: [sections[0], {...sections[0],label: 'Another state'}] })).ok, false);
  assert.equal((await handleHealthLabExplanationRequest({ ...input, sections: sections.map((section, index) =>
    index ? section : { ...section, text: 'AI changed text' }) })).ok, false);
});

test('lab Agent deterministically seals approved blocks without invoking AI', async () => {
  const result = await handleHealthLabExplanationRequest(valid);
  assert.deepEqual(result, { ok: true, data: sealedValid, provider: 'deterministic' });
  assert.doesNotMatch(JSON.stringify(result), /evidence|numericValue/);
});

test('lab Agent accepts the governed 5b Harbor Uitleg source sheet', async () => {
  const input = {
    ...valid,
    marker: 'CRP',
    stateCode: 'NORMAL',
    level: 'L1',
    blocks: { a: 'CRP N1' },
    text: 'CRP N1',
    provenance: { ...valid.provenance, sourceSheet: '5b. Harbor Uitleg (leidend)', sourceRow: 21 },
  };

  const result = await handleHealthLabExplanationRequest(input);

  const { evidence: _inputEvidence, ...sealedInput } = input;
  assert.deepEqual(result, { ok: true, data: sealedInput, provider: 'deterministic' });
});

test('lab Agent emits correlated diagnostics proving that no AI provider was invoked', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await handleHealthLabExplanationHttpRequest({
    authorization: 'Bearer health-token', serviceToken: 'health-token',
    bodyText: JSON.stringify(valid), traceId: 'trace-lab-1',
    logger: event => events.push(event),
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(events.map(event => ({
    traceId: event.traceId,
    stage: event.stage,
    outcome: event.outcome,
    aiProviderInvoked: event.aiProviderInvoked,
    provider: event.provider,
  })), [
    { traceId: 'trace-lab-1', stage: 'request_received', outcome: 'started', aiProviderInvoked: false, provider: undefined },
    { traceId: 'trace-lab-1', stage: 'deterministic_kb_seal', outcome: 'accepted', aiProviderInvoked: false, provider: 'deterministic' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /Blok A|Geen diagnose/);
});

test('lab Agent rejects a response whose text does not equal its approved blocks', async () => {
  const result = await handleHealthLabExplanationRequest({ ...valid, text: 'Invented text' });
  assert.deepEqual(result, { ok: false, code: 'HEALTH_LAB_EXPLANATION_OUTPUT_REJECTED' });
});

test('lab Agent rejects approval metadata that differs from the approved source row', async () => {
  const result = await handleHealthLabExplanationRequest({ ...valid, approvedBy: 'Otro médico' });
  assert.deepEqual(result, { ok: false, code: 'HEALTH_LAB_EXPLANATION_OUTPUT_REJECTED' });
});

test('lab Agent HTTP capability requires the Health service token', async () => {
  const bodyText = JSON.stringify(valid);
  const unauthorized = await handleHealthLabExplanationHttpRequest({
    authorization: 'Bearer wrong-token', serviceToken: 'health-token', bodyText,
  });
  assert.equal(unauthorized.statusCode, 401);

  const accepted = await handleHealthLabExplanationHttpRequest({
    authorization: 'Bearer health-token', serviceToken: 'health-token', bodyText,
  });
  assert.deepEqual(accepted, { statusCode: 200, body: { ok: true, data: sealedValid, provider: 'deterministic' } });
});
