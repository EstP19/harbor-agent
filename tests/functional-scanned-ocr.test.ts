import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFunctionalText } from '../agent/extractors/functional-text-extractor.ts';
import { parsePdfText, parseScannedPdfOcr } from '../agent/tools/pdf-tool.ts';
import { scannedFunctionalPdf, scannedFunctionalImage, harborLanguagesImage, harborLanguagesPdf } from './helpers/scanned-functional-fixture.ts';

test('Vercel OCR reads every image-only Functional PDF page in order and preserves it as a transcript', { timeout: 120_000 }, async () => {
  const previous = process.env.VERCEL; process.env.VERCEL = '1';
  try {
    const pdf = scannedFunctionalPdf();
    const native = await parsePdfText(pdf);
    assert.equal(native.total, 2); assert.ok(native.pages.every(page => !page.text));
    const result = await extractFunctionalText({ documentContent: `data:application/pdf;base64,${pdf.toString('base64')}`, mimeType: 'application/pdf' });
    assert.match(result.extractedText, /HARBOR SCAN PAGE ONE/);
    assert.match(result.extractedText, /HARBOR SCAN PAGE TWO/);
    assert.ok(result.extractedText.indexOf('PAGE ONE') < result.extractedText.indexOf('PAGE TWO'));
    assert.match(result.extractedText, /3[.,]20/); assert.match(result.extractedText, /450/);
    assert.equal(result.documentCategory, 'functional'); assert.deepEqual(result.observations, []);
    assert.equal(result.functionalData.rawText, result.extractedText);
    const secondOnly = await parseScannedPdfOcr(pdf, [2], 'nld+eng+spa');
    assert.deepEqual([...secondOnly.keys()], [2]); assert.match(secondOnly.get(2)!, /PAGE TWO/);
  } finally { if (previous === undefined) delete process.env.VERCEL; else process.env.VERCEL = previous; }
});

test('Functional OCR preserves the seven Harbor languages, including Papiamento accents', { timeout: 60_000 }, async () => {
  for (const [mimeType, bytes] of [['image/jpeg', harborLanguagesImage()], ['application/pdf', harborLanguagesPdf()]] as const) {
    const result = await extractFunctionalText({ documentContent: `data:${mimeType};base64,${bytes.toString('base64')}`, mimeType });
    for (const phrase of ['capacidad respiratoria', 'respiratory capacity', 'ademhalingscapaciteit', 'capacité respiratoire', 'Funktionsprüfung', 'respiratória', 'Konsultá bo dòkter']) {
      assert.ok(result.extractedText.includes(phrase), `Missing literal phrase: ${phrase}\n${result.extractedText}`);
    }
    assert.deepEqual(result.observations, []);
  }
});

test('Functional image OCR uses bundled models and does not fabricate laboratory observations', { timeout: 60_000 }, async () => {
  const result = await extractFunctionalText({ documentContent: `data:image/jpeg;base64,${scannedFunctionalImage().toString('base64')}`, mimeType: 'image/jpeg' });
  assert.match(result.extractedText, /HARBOR SCAN PAGE ONE/);
  assert.match(result.extractedText, /4[.,]10/);
  assert.deepEqual(result.observations, []); assert.deepEqual(result.functionalData.results, []);
});
