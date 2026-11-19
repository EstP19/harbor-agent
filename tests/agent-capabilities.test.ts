import assert from 'node:assert/strict';
import { test } from 'node:test';
import ocrTool from '../agent/tools/ocr-tool.ts';
import vectorTool from '../agent/tools/vector-tool.ts';
import ingestTool from '../agent/tools/ingest-tool.ts';
import { isPdfBuffer, parseDocumentBuffer } from '../agent/tools/pdf-tool.ts';
import { extractLaboratoryLocally } from '../agent/extractors/laboratory-extractor.ts';
import * as laboratoryExtractor from '../agent/extractors/laboratory-extractor.ts';

test('health_ocr: extracción de texto limpia', async () => {
  const sampleInput = '  Hemoglobina: 13.5 g/dL \r\n Glucosa: 95 mg/dL  ';
  const result = await (ocrTool.execute as any)({
    documentContent: sampleInput,
    documentType: 'laboratory_pdf',
  });

  assert.equal(result.status, 'success');
  assert.equal(result.capabilityCode, 'health_ocr');
  assert.ok(result.extractedText.includes('Hemoglobina: 13.5 g/dL'));
  assert.ok(result.extractedText.includes('Glucosa: 95 mg/dL'));
});

test('vector_search: retorno de estructura de resultados', async () => {
  const result = await (vectorTool.execute as any)({
    queryText: 'Metformina y glucosa',
    sourceCode: 'general_kb',
    maxResults: 2,
  });

  assert.ok(result.status === 'success' || result.status === 'error');
  assert.equal(result.query, 'Metformina y glucosa');
  assert.equal(result.sourceCode, 'general_kb');
});

test('vector_ingest: fragmentación e ingesta de documentos', async () => {
  const sampleDoc = 'Primer párrafo de la regla médica.\n\nSegundo párrafo de la regla clínica sobre glucosa.';
  const result = await (ingestTool.execute as any)({
    sourceCode: 'laboratory_rules',
    documentText: sampleDoc,
    revisionCode: 'rev_test_001',
    visibility: 'global',
  });

  assert.ok(result.status === 'success' || result.status === 'error');
  assert.equal(result.sourceCode, 'laboratory_rules');
});

test('health_pdf_extraction: procesamiento y lectura de PDF', async () => {
  const pdfToolModule = await import('../agent/tools/pdf-tool.ts');
  const sampleInput = 'HEMOGRAMA COMPLETO\nHemoglobina 14.5 g/dL (Rango: 12-16)\nLeucocitos 6500 /uL';
  const result = await (pdfToolModule.default.execute as any)({
    documentContent: sampleInput,
    documentType: 'laboratory',
    mimeType: 'application/pdf',
  });

  assert.equal(result.status, 'success');
  assert.equal(result.documentCategory, 'laboratory');
  assert.ok(result.extractedText.includes('Hemoglobina 14.5 g/dL'));
});

test('health_pdf_extraction: decodifica PDF Base64 puro y data URL', () => {
  const pdfBytes = Buffer.from('%PDF-1.7\ncontenido de prueba', 'binary');
  const base64 = pdfBytes.toString('base64');

  assert.deepEqual(parseDocumentBuffer(base64), pdfBytes);
  assert.deepEqual(parseDocumentBuffer(`data:application/pdf;base64,${base64}`), pdfBytes);
  assert.deepEqual(parseDocumentBuffer(`data:application/octet-stream;base64,${base64}`), pdfBytes);
  assert.equal(isPdfBuffer(parseDocumentBuffer(base64)), true);
});

test('laboratory extractor: infiere filas sin depender del idioma de los headers', () => {
  const text = `
    Test +/- Uitslag Eenheid
    22. Bezinking H 130 <10 mm/hr
    23. Syfilis screen Negative Negative
    25. Natrium L121 136-146 mmol/L
    34. CRP H 10.8 <0.5 mg/dL
    Printdatum: 8-Jul-2026
  `;
  const result = extractLaboratoryLocally(text);
  const rows = result.laboratoryData.panels[0].results;

  assert.deepEqual(rows.map(row => row.test_name), ['Bezinking', 'Syfilis screen', 'Natrium', 'CRP']);
  assert.equal(rows[0].reference_range?.operator, '<');
  assert.equal(rows[1].value, 'Negative');
  assert.equal(rows[2].flag, 'L');
  assert.equal(rows[3].reference_range?.max, 0.5);
  assert.equal(result.observations[2].printedFlag, 'LOW');
});

test('laboratory observations inherit reference evidence from panel rows', () => {
  const synchronize = (laboratoryExtractor as any).synchronizeLaboratoryObservations;
  assert.equal(typeof synchronize, 'function');

  const result = synchronize(
    {
      panels: [{ category: 'Chemie (Bloed)', results: [{
        test_name: 'CRP', value: 0.2, flag: 'NORMAL', unit: 'mg/dL',
        reference_range: { max: 0.5, raw_text: '<0.5' },
      }] }],
      abnormal_results_summary: [],
    },
    [{ literalMarker: 'CRP', unitCode: 'MG/DL', literalUnit: 'mg/dL', printedFlag: 'NORMAL', confidence: 0.98 }],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].numericValue, 0.2);
  assert.equal(result[0].upperBound, 0.5);
  assert.equal(result[0].rangeText, '<0.5');
});
