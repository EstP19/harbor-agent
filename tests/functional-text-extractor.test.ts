import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFunctionalText } from '../agent/extractors/functional-text-extractor.ts';
import { readFileSync, existsSync } from 'node:fs';

function nativePdf(text: string) {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}

test('serverless Functional native PDF retains the real transcript and bundles both parser workers', async () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const assets = ['pdf-parse/dist/pdf-parse/cjs/pdf.worker.mjs', 'pdfjs-dist/legacy/build/pdf.worker.mjs'];
  for (const asset of assets) {
    assert.ok(config.functions['api/handler.ts'].includeFiles.includes(asset));
    assert.ok(existsSync(new URL('../node_modules/' + asset, import.meta.url)));
  }
  const previousVercel = process.env.VERCEL;
  process.env.VERCEL = '1';
  const text = 'SYNTHETIC SOFTWARE TEST. Spirometry FEV1 3.2 L and FVC 4.1 L. This is a test report, not a real patient.';
  try {
    const result = await extractFunctionalText({ documentContent: `data:application/pdf;base64,${nativePdf(text).toString('base64')}`, mimeType: 'application/pdf' });
    assert.ok(result.extractedText.includes('Spirometry FEV1 3.2 L'));
    assert.deepEqual(result.observations, []);
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});

test('Functional literal text is preserved without generative extraction or laboratory observations', async () => {
  const report = 'Spirometrie\nFEV1: 3,2 L\nConclusie: normaal';
  const plain = await extractFunctionalText({ documentContent: report, mimeType: 'text/plain' });
  assert.equal(plain.documentCategory, 'functional');
  assert.equal(plain.extractedText, report);
  assert.deepEqual(plain.observations, []);
  assert.deepEqual(plain.functionalData, { rawText: report, results: [] });
  const encoded = await extractFunctionalText({ documentContent: `data:text/plain;base64,${Buffer.from(report).toString('base64')}`, mimeType: 'text/plain' });
  assert.deepEqual(encoded, plain);
});

test('empty Functional transcription fails rather than fabricating results', async () => {
  await assert.rejects(() => extractFunctionalText({ documentContent: '  ', mimeType: 'text/plain' }), /FUNCTIONAL_TEXT_UNAVAILABLE/);
});
