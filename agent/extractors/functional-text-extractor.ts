import { createLocalOcrWorker, FUNCTIONAL_OCR_LANGUAGES } from '../../lib/local-ocr.ts';
import { isPdfBuffer, parseDocumentBuffer, parsePdfText, parseScannedPdfOcr } from '../tools/pdf-tool.ts';

/** Functional transcription uses PDF text or OCR; no generative model is invoked. */
export async function extractFunctionalText(input: { documentContent: string; mimeType?: string }) {
  let extractedText: string;
  const buffer = parseDocumentBuffer(input.documentContent);
  if (isPdfBuffer(buffer)) {
    const native = await parsePdfText(buffer);
    const missing = native.pages.filter(page => page.text.trim().length < 80).map(page => page.num);
    const scanned = await parseScannedPdfOcr(buffer, native.pages.length ? missing : undefined, FUNCTIONAL_OCR_LANGUAGES);
    if (native.pages.some(page => !page.text.trim() && !scanned.get(page.num)?.trim())) throw new Error('FUNCTIONAL_OCR_INCOMPLETE');
    extractedText = native.pages.length
      ? native.pages.map(page => scanned.get(page.num) || page.text).join('\n')
      : [...scanned.values()].join('\n');
  } else if (input.documentContent.startsWith('data:image/') || input.mimeType?.startsWith('image/')) {
    const worker = await createLocalOcrWorker(FUNCTIONAL_OCR_LANGUAGES);
    try {
      extractedText = (await worker.recognize(buffer)).data.text;
    }
    finally { await worker.terminate(); }
  } else {
    extractedText = /^data:[^,]*;base64,/iu.test(input.documentContent) ? buffer.toString('utf8') : input.documentContent;
  }
  if (!extractedText.trim()) throw new Error('FUNCTIONAL_TEXT_UNAVAILABLE');
  return { documentCategory: 'functional', extractedText, functionalData: { rawText: extractedText, results: [] }, observations: [] };
}
