import assert from 'node:assert/strict';
import test from 'node:test';

import { handleFunctionalKbAnalysis } from '../agent/capabilities/health-functional-kb-analysis/handler.ts';

const hash = `sha256:${'a'.repeat(64)}`;

test('accepts a content-supported functional KB role map', async () => {
  const result = await handleFunctionalKbAnalysis({
    contractVersion: 'functional-source-map/v1',
    workbookHash: hash,
    sheets: [
      { sourceSheet: 'renamed-a', rows: [['Harbor Function ID', 'Onderzoek NL', 'Methode / protocol']] },
      { sourceSheet: 'renamed-b', rows: [['ID', 'Term', 'Uitleg', 'Bron']] },
    ],
  }, async () => ({
    provider: 'openai',
    parsed: {
      workbookHash: hash,
      sheets: [
        { sourceSheet: 'renamed-a', role: 'study_registry', evidenceRow: 1 },
        { sourceSheet: 'renamed-b', role: 'clinical_explanations', evidenceRow: 1 },
      ],
    },
  }));

  assert.equal(result.ok, true);
});

test('rejects missing sheets, invented rows and extra output', async () => {
  const result = await handleFunctionalKbAnalysis({
    contractVersion: 'functional-source-map/v1',
    workbookHash: hash,
    sheets: [{ sourceSheet: 'one', rows: [['ID', 'Term']] }],
  }, async () => ({
    provider: 'gemini',
    parsed: {
      workbookHash: hash,
      sheets: [{ sourceSheet: 'one', role: 'clinical_explanations', evidenceRow: 2 }],
    },
  }));

  assert.deepEqual(result, { ok: false, code: 'FUNCTIONAL_KB_ANALYSIS_OUTPUT_INVALID' });
});
