import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthOcrHandler } from '../agent/capabilities/health-ocr/handler.ts';
import { handleHealthOcrHttpRequest } from '../agent/capabilities/health-ocr/route.ts';

const input = {
  contractVersion: 'health-ocr/v1', requestKey: 'a'.repeat(64),
  documentContent: 'Glucosa 112 mg/dL', documentType: 'lab', mimeType: 'text/plain',
};

test('OCR boundary requires service authentication and rejects malformed output', async () => {
  const unauthorized = await handleHealthOcrHttpRequest({ authorization: undefined, serviceToken: 'secret', bodyText: JSON.stringify(input), handler: async () => ({ ok: true, output: {} as never }) });
  assert.equal(unauthorized.statusCode, 401);
  const handler = createHealthOcrHandler({ execute: async () => ({ status: 'success', documentCategory: 'laboratory', observations: 'wrong' }) });
  assert.deepEqual(await handler(input), { ok: false, code: 'HEALTH_OCR_OUTPUT_REJECTED' });
});

test('OCR handler returns structured output without logging clinical content', async () => {
  const messages: string[] = [];
  const handler = createHealthOcrHandler({
    execute: async () => ({ status: 'success', documentCategory: 'laboratory', observations: [{ literalMarker: 'Glucosa', numericValue: 112 }] }),
    logger: { info: message => messages.push(message), warn: message => messages.push(message) },
  });
  const result = await handler(input);
  assert.equal(result.ok, true);
  assert.doesNotMatch(messages.join('\n'), /Glucosa|112|documentContent/);
});
