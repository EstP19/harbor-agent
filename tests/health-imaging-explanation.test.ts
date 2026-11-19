import assert from 'node:assert/strict';
import test from 'node:test';
import { handleHealthImagingExplanationRequest } from '../agent/capabilities/health-imaging-explanation/handler.ts';
import { handleHealthImagingExplanationHttpRequest } from '../agent/capabilities/health-imaging-explanation/route.ts';

const candidate = {
  id: 'UITL-001', releaseId: 'release-1', status: 'approved', languageCode: 'nl', lastVerified: '2026-09-27',
  modality: 'X-thorax', term: 'Atelectase', aliases: ['volumeverlies'], explanation: 'Een deel van de long is minder ontplooid.',
  boundary: 'Dit stelt geen oorzaak vast.', source: 'LESA', reviewer: 'Reviewed doctor',
  authorizedCountries: ['NL'], sourceSheet: 'Data', sourceRow: 6, rowHash: 'a'.repeat(64),
};
const payload = { contractVersion: 'health-imaging-explanation/v2', releaseId: 'release-1', reportFinding: 'Atelectase', modality: 'X-thorax', patientCountry: 'NL', patientLanguage: 'nl', candidates: [candidate] };

test('runtime returns the exact authored text and source without ever calling AI', async () => {
  const result = await handleHealthImagingExplanationRequest(payload, { completion: async () => { throw new Error('AI must not run'); } });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.provider, 'deterministic');
    assert.equal(result.data.explanation, candidate.explanation);
    assert.equal(result.data.clinicalSource, candidate.source);
  }
  assert.deepEqual(await handleHealthImagingExplanationRequest({ ...payload, reportFinding: 'VOLUMEVERLIES' }), result);
});

test('prose, another modality, another language and a different release cannot select an answer', async () => {
  for (const change of [{ reportFinding: 'Geen atelectase' }, { reportFinding: 'Subsegmentale atelectase' }, { modality: 'MRI hersenen' }, { patientLanguage: 'es' }, { releaseId: 'release-2' }]) {
    assert.deepEqual(await handleHealthImagingExplanationRequest({ ...payload, ...change }), { ok: false, code: 'HEALTH_IMAGING_EXPLANATION_NO_MATCH' });
  }
});

test('ambiguous aliases, drafts, missing provenance and unauthorized countries fail closed', async () => {
  assert.deepEqual(await handleHealthImagingExplanationRequest({ ...payload, candidates: [candidate, { ...candidate, id: 'UITL-002' }] }), { ok: false, code: 'HEALTH_IMAGING_EXPLANATION_AMBIGUOUS' });
  for (const change of [{ status: 'candidate' }, { source: '' }, { reviewer: '' }, { rowHash: undefined }, { authorizedCountries: [] }]) {
    assert.equal((await handleHealthImagingExplanationRequest({ ...payload, candidates: [{ ...candidate, ...change }] })).ok, false);
  }
  assert.deepEqual(await handleHealthImagingExplanationRequest({ ...payload, patientCountry: 'BE' }), { ok: false, code: 'HEALTH_IMAGING_COUNTRY_UNAUTHORIZED' });
});

test('HTTP requires service authorization and v1 AI-selection requests are rejected', async () => {
  assert.equal((await handleHealthImagingExplanationHttpRequest({ authorization: undefined, serviceToken: 'secret', bodyText: JSON.stringify(payload) })).statusCode, 401);
  const result = await handleHealthImagingExplanationHttpRequest({ authorization: 'Bearer secret', serviceToken: 'secret', bodyText: JSON.stringify(payload) });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal((await handleHealthImagingExplanationRequest({ ...payload, contractVersion: 'health-imaging-explanation/v1' })).ok, false);
});
