import { defineTool } from '../../lib/tool-helper.ts';
import { z } from 'zod';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { createLocalOcrWorker } from '../../lib/local-ocr.ts';

// PDF.js needs real canvas primitives to render scans, including on Vercel.
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });

async function getPdfJs() {
  return await import('pdfjs-dist/legacy/build/pdf.mjs');
}

import { createRequire } from 'node:module';
let pdfParseModule: any = null;
try {
  const req = createRequire(import.meta.url);
  pdfParseModule = req('pdf-parse');
} catch {
  // En serverless Vercel pdf-parse puede no estar empaquetado; se usa fallback con pdfjs
}

import { extractRadiologyLocally } from '../extractors/radiology-extractor.ts';
import type { RadiologyExtractionResult, StructuredObservation } from '../extractors/radiology-extractor.ts';
import { extractLaboratoryLocally, synchronizeLaboratoryObservations } from '../extractors/laboratory-extractor.ts';
import type { LaboratoryExtractionResult } from '../extractors/laboratory-extractor.ts';
import { extractWearableLocally } from '../extractors/wearable-extractor.ts';
import type { WearableExtractionResult } from '../extractors/wearable-extractor.ts';
import { extractAppleECGLocally } from '../extractors/apple-ecg-extractor.ts';
import type { AppleECGExtractionResult } from '../extractors/apple-ecg-extractor.ts';
import { extractAppleHealthLocally } from '../extractors/apple-health-extractor.ts';
import type { AppleHealthPassiveBiometrics } from '../extractors/apple-health-extractor.ts';
import { generateAiJsonResponse } from '../../lib/ai-provider.ts';

const MIN_NATIVE_TEXT_CHARS_PER_PAGE = 80;
const TARGET_OCR_PAGE_WIDTH = 2_400;
const MAX_OCR_RENDER_SCALE = 4;
const MAX_OCR_PIXELS = 8_000_000;

class OcrCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(target: { canvas: ReturnType<typeof createCanvas> }, width: number, height: number) {
    target.canvas.width = Math.ceil(width); target.canvas.height = Math.ceil(height);
  }
  destroy(target: { canvas: ReturnType<typeof createCanvas> }) {
    target.canvas.width = 0; target.canvas.height = 0;
  }
}

export type DocumentCategory = 'radiology' | 'laboratory' | 'wearable' | 'apple_ecg' | 'apple_health';

interface PdfTextPage {
  num: number;
  text: string;
}

interface PdfTextExtraction {
  pages: PdfTextPage[];
  total: number;
}

export async function parseScannedPdfOcr(buffer: Buffer, pageNumbers?: number[], languages = 'spa+eng'): Promise<Map<number, string>> {
  const pageText = new Map<number, string>();
  if (pageNumbers && pageNumbers.length === 0) return pageText;

  let pdfDocument: any;
  let worker: any;
  try {
    const pdfjs = await getPdfJs();
    pdfDocument = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      CanvasFactory: OcrCanvasFactory,
    }).promise;

    if (!pdfDocument?.canvasFactory?.create) {
      console.warn('[harbor-agent :pdfTool] canvasFactory no disponible en este entorno.');
      return pageText;
    }

    worker = await createLocalOcrWorker(languages);

    const targetPages = pageNumbers || Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1);
    for (const pageNumber of targetPages) {
      if (pageNumber < 1 || pageNumber > pdfDocument.numPages) continue;

      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(MAX_OCR_RENDER_SCALE, TARGET_OCR_PAGE_WIDTH / baseViewport.width,
        Math.sqrt(MAX_OCR_PIXELS / (baseViewport.width * baseViewport.height)));
      const viewport = page.getViewport({ scale });
      const target = pdfDocument.canvasFactory.create(viewport.width, viewport.height);
      try {
        await page.render({ canvas: target.canvas, canvasContext: target.context, viewport }).promise;
        const ret = await worker.recognize(target.canvas.toBuffer('image/png'));
        pageText.set(pageNumber, (ret?.data?.text || '').trim());
      } finally {
        pdfDocument.canvasFactory.destroy(target);
        page.cleanup();
      }
    }
  } catch (ocrErr) {
    console.warn('[harbor-agent :pdfTool] parseScannedPdfOcr falló:', (ocrErr as any)?.message || ocrErr);
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch {}
    }
    if (pdfDocument) {
      try { await pdfDocument.destroy(); } catch {}
    }
  }

  return pageText;
}


export async function parsePdfText(buffer: Buffer): Promise<PdfTextExtraction> {
  if (pdfParseModule) {
    try {
      const PDFParse = pdfParseModule.PDFParse || pdfParseModule.default?.PDFParse;
      if (typeof PDFParse === 'function') {
        const parser = new PDFParse({ data: buffer });
        const res = await parser.getText();
        if (Array.isArray(res?.pages)) {
          return {
            pages: res.pages.map((page: any, index: number) => ({
              num: Number(page?.num) || index + 1,
              text: String(page?.text || '').trim(),
            })),
            total: Number(res?.total) || res.pages.length,
          };
        }

        const rawText = typeof res === 'string' ? res : (res?.text || '');
        const cleanText = rawText.replace(/--\s*\d+\s*of\s*\d+\s*--/gi, '').trim();
        return { pages: [{ num: 1, text: cleanText }], total: 1 };
      }
    } catch (e) {
      console.warn('[harbor-agent :pdfTool] Error llamando a pdf-parse:', e);
    }
  }

  try {
    const pdfjs = await getPdfJs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
    const pages: PdfTextPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(' ');
      pages.push({ num: i, text: pageText.trim() });
    }
    return { pages, total: doc.numPages };
  } catch (err) {
    console.warn('[harbor-agent :pdfTool] Falló extracción con pdfjs:', err);
    return { pages: [], total: 0 };
  }
}

export function parseDocumentBuffer(content: string): Buffer {
  if (content.startsWith('%PDF-')) return Buffer.from(content, 'binary');

  // Trust the PDF magic bytes below, not the browser-provided MIME alone.
  const dataUrlMatch = content.match(/^data:[^,]*;base64,(.+)$/is);
  const cleanBase64 = dataUrlMatch ? dataUrlMatch[1] : content;
  return Buffer.from(cleanBase64.replace(/\s+/g, ''), 'base64');
}

export function isPdfBuffer(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
}

function detectDocumentCategory(text: string, documentType?: string): DocumentCategory {
  const dt = (documentType || '').toLowerCase().trim();

  if (dt === 'other' || dt === 'apple_health' || dt === 'applehealth' || dt === 'passive_biometrics' || dt.includes('apple') || dt === 'health') return 'apple_health';
  if (dt === 'wearable' || dt === 'fitness' || dt === 'garmin' || dt === 'strava' || dt === 'apple_fitness') return 'wearable';
  if (dt === 'apple_ecg' || dt === 'ecg') return 'apple_ecg';
  if (dt === 'radiology' || dt === 'xray' || dt === 'mri' || dt === 'ct') return 'radiology';
  if (dt === 'laboratory' || dt === 'lab' || dt === 'blood') return 'laboratory';

  const t = text.toUpperCase();

  if (
    t.includes('WORKOUT') ||
    t.includes('INDOOR RUN') ||
    t.includes('OUTDOOR RUN') ||
    t.includes('ACTIVE CALORIES') ||
    t.includes('ELAPSED TIME') ||
    t.includes('WORKOUT TIME') ||
    t.includes('AVG. CADENCE') ||
    t.includes('AVG. PACE') ||
    t.includes('GARMIN') ||
    t.includes('STRAVA')
  ) {
    return 'wearable';
  }

  if (t.includes('ELECTROCARDIOGRAM') || t.includes('SINUS RHYTHM') || t.includes('ATRIAL FIBRILLATION')) {
    return 'apple_ecg';
  }

  if (
    t.includes('RESTING') ||
    t.includes('RESTING HEART RATE') ||
    t.includes('HEART RATE VARIABILITY') ||
    t.includes('VO2 MAX') ||
    t.includes('SLEEP ANALYSIS')
  ) {
    return 'apple_health';
  }

  if (t.includes('IMPRESSION') || t.includes('RADIUS') || t.includes('MRI') || t.includes('X-RAY') || t.includes('RADIOLOG')) {
    return 'radiology';
  }

  return 'laboratory';
}

export default defineTool({
  description:
    'Herramienta dedicada para la lectura y extracción de texto de documentos PDF (digitales y escaneados) y estructuración desacoplada por categoría.',
  inputSchema: z.object({
    documentContent: z
      .string()
      .describe('Representación Base64 del archivo PDF o datos del documento.'),
    documentType: z
      .string()
      .default('primary_ocr')
      .describe('Categoría solicitada para el documento (lab, radiology, wearable, apple_health).'),
    mimeType: z.string().optional(),
  }),
  async execute({ documentContent, documentType, mimeType }): Promise<any> {
    if (['radiology','xray','mri','ct'].includes((documentType || '').toLowerCase().trim())) {
      const {extractRadiologyText}=await import('../extractors/radiology-text-extractor.ts');
      return extractRadiologyText({documentContent,mimeType});
    }
    console.log(`[harbor-agent :pdfTool] 📄 Procesando documento PDF para documentType: ${documentType}`);

    let extractedText = '';
    let pdfBuffer: Buffer | undefined;
    let pdfPages: PdfTextPage[] = [];
    let pagesReadWithOcr = 0;

    try {
      pdfBuffer = parseDocumentBuffer(documentContent);
      const isRealPdf = isPdfBuffer(pdfBuffer);
      if (isRealPdf) {
        console.log(`[harbor-agent :pdfTool] 🔍 Extrayendo capa de texto nativa con pdf-parse (${pdfBuffer.length} bytes)...`);
        const nativeExtraction = await parsePdfText(pdfBuffer);
        pdfPages = nativeExtraction.pages;
        console.log(`[harbor-agent :pdfTool] ✓ pdf-parse completado: ${nativeExtraction.total} páginas inspeccionadas.`);

        if (pdfPages.length === 0) {
          console.log('[harbor-agent :pdfTool] ⚠️ No se pudo enumerar la capa nativa. Renderizando todas las páginas para OCR...');
          const ocrPages = await parseScannedPdfOcr(pdfBuffer);
          pagesReadWithOcr = ocrPages.size;
          pdfPages = [...ocrPages].map(([num, text]) => ({ num, text }));
        } else {
          const pagesNeedingOcr = pdfPages
            .filter(page => page.text.replace(/\s+/g, '').length < MIN_NATIVE_TEXT_CHARS_PER_PAGE)
            .map(page => page.num);
          if (pagesNeedingOcr.length > 0) {
            console.log(`[harbor-agent :pdfTool] ⚠️ ${pagesNeedingOcr.length}/${pdfPages.length} páginas no tienen texto nativo suficiente. Activando OCR...`);
            const ocrPages = await parseScannedPdfOcr(pdfBuffer, pagesNeedingOcr);
            pagesReadWithOcr = ocrPages.size;
            pdfPages = pdfPages.map(page => ({
              ...page,
              text: ocrPages.get(page.num) || page.text,
            }));
          }
        }

        extractedText = pdfPages
          .map(page => `--- Página ${page.num} ---\n${page.text}`)
          .join('\n\n')
          .trim();
      } else {
        // Preserve support for callers that send already-extracted plain text to
        // this tool, but never pass PDF Base64 to the image OCR path.
        extractedText = documentContent;
      }
    } catch (parseErr) {
      console.warn('[harbor-agent :pdfTool] Aviso durante lectura preliminar de PDF:', parseErr);
      extractedText = '';
    }

    const hasExtractedText = extractedText.replace(/--- Página \d+ ---/g, '').trim().length > 10;
    const category = detectDocumentCategory(hasExtractedText ? extractedText : (documentType || 'laboratory'), documentType);
    if(category==='radiology') {
      const {extractRadiologyText}=await import('../extractors/radiology-text-extractor.ts');
      return extractRadiologyText({documentContent,mimeType});
    }
    console.log(`[harbor-agent :pdfTool] 🎯 Categoría detectada en PDF: ${category.toUpperCase()}`);


    const apiKey = process.env.OPENAI_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (process.env.HARBOR_AI_PRIMARY === 'chatgpt' || (apiKey && apiKey.length > 10) || (geminiKey && geminiKey.length > 10)) {
      try {
        console.log(`[harbor-agent :pdfTool] 🤖 Estructurando datos de PDF (${category}) con LLM...`);

        const promptByCategory: Record<DocumentCategory, string> = {
          radiology: `Eres un extractor experto de informes radiológicos (Rayos X, RM, TAC, Ecografía). Retorna exclusivamente un JSON válido con esta estructura:
{
  "documentCategory": "radiology",
  "radiologyData": {
    "metadata": { "patient_side": "RIGHT"|"LEFT"|"BILATERAL"|"UNSPECIFIED", "anatomical_region": "KNEE|CHEST|...", "procedures": [{"modality": "XR", "description": "..."}] },
    "findings_key_measurements": [{"finding": "...", "measurement": "15.7 mm", "modality": "XR/US"}],
    "impression": ["..."]
  },
  "observations": [{"literalMarker": "...", "numericValue": 15.7, "unitCode": "MM", "literalUnit": "MM", "printedFlag": "ABNORMAL", "confidence": 0.95}]
}`,
          laboratory: `Eres un extractor experto de informes de laboratorio clínico en formato PDF. Los nombres, idiomas, orden y cantidad de columnas cambian entre laboratorios: infiere semánticamente qué columna representa prueba, resultado, unidad, indicador y rango de referencia; no dependas de encabezados fijos. Conserva resultados cualitativos (por ejemplo Positivo, Negativo, Reactivo o No reactivo) como strings. NO inventes valores ausentes, NO confundas identificadores/fechas con resultados y NO agrupes ni categorices en categorías artificiales. Extrae una lista plana lineal de todas las pruebas tal como aparecen. Retorna exclusivamente un JSON válido con esta estructura:
{
  "documentCategory": "laboratory",
  "laboratoryData": {
    "printedLabName": "...", "patientName": "...", "reportDate": "...",
    "tableHeaders": ["Prueba / Análisis", "Resultado", "Unidad", "Rango de Referencia"],
    "panels": [{"category": "Resultados Extraídos", "headers": ["Prueba / Análisis", "Resultado", "Unidad", "Rango de Referencia"], "results": [{"test_name": "Hemoglobina", "value": 14.2, "flag": "NORMAL", "unit": "g/dL", "reference_range": {"min": 12, "max": 16, "raw_text": "12-16"}}] }],
    "abnormal_results_summary": ["..."]
  },
  "observations": [{"literalMarker": "Hemoglobina", "numericValue": 14.2, "unitCode": "G/DL", "literalUnit": "g/dL", "printedFlag": "NORMAL", "confidence": 0.98}]
}`,
          wearable: `Eres un agente experto de extracción de métricas de entrenamientos deportivos y wearables desde un reporte PDF. Retorna exclusivamente un JSON válido con esta estructura:
{
  "documentCategory": "wearable",
  "wearableData": {
    "activity_type": "INDOOR_RUN",
    "metadata": { "date": "2026-07-25", "start_time": "09:19", "end_time": "09:50", "location": "Willemstad" },
    "duration": { "active_duration_seconds": 1866, "elapsed_duration_seconds": 1903, "active_time_formatted": "0:31:06", "elapsed_time_formatted": "0:31:43" },
    "distance": { "value": 3.30, "unit": "KM" },
    "metrics": {
      "active_calories": { "value": 253, "unit": "CAL" },
      "total_calories": { "value": 315, "unit": "CAL" },
      "average_cadence": { "value": 124, "unit": "SPM" },
      "average_pace": { "raw_value": "9'25\\"", "unit": "min/km", "seconds_per_km": 565 },
      "average_heart_rate": { "value": 134, "unit": "BPM" }
    },
    "subjective_feedback": { "effort_score": 6, "effort_label": "Moderate" }
  }
}`,
          apple_health: `Eres un agente experto de extracción de biometría de Apple Health desde PDF. Extrae la métrica y el valor exacto de AVERAGE/PROMEDIO impreso en el documento. Retorna exclusivamente un JSON válido con esta estructura:
{
  "documentCategory": "apple_health",
  "appleHealthData": {
    "metric": "RESTING_HEART_RATE",
    "metric_category": "Cardiovascular / Heart",
    "aggregation": { "selected_view": "M", "period": "2026-07", "period_display": "Jul 2026" },
    "summary": { "type": "AVERAGE", "value": 67, "unit": "BPM", "trend": "NONE" },
    "chart_context": {
      "y_axis_range": { "min": 50, "max": 80 },
      "key_observations": { "lowest_approx_value": 67, "highest_approx_value": 67 }
    }
  },
  "observations": [{"literalMarker": "Resting Heart Rate", "numericValue": 67, "unitCode": "BPM", "literalUnit": "BPM", "printedFlag": "NORMAL", "confidence": 0.98}]
}`,
          apple_ecg: `Eres un extractor experto de electrocardiogramas desde reporte PDF. Retorna exclusivamente un JSON válido con esta estructura:
{
  "documentCategory": "apple_ecg",
  "appleECGData": {
    "analysis_type": "APPLE_WATCH_LEAD_1_ECG", "classification": "SINUS_RHYTHM", "rhythm_classification": "Sinus rhythm", "heart_rate_bpm": 68,
    "duration_s": 30, "sampling_rate": 512, "is_noisy": false, "electrical_axis_deviation": "Normal", "ecg_notes": ["No se detectó fibrilación auricular."]
  },
  "observations": [{"literalMarker": "Frecuencia Cardíaca ECG", "numericValue": 68, "unitCode": "BPM", "literalUnit": "BPM", "printedFlag": "NORMAL", "confidence": 0.99}]
}`
        };

        let parsed: any = null;

        const userPromptText = hasExtractedText
          ? `Texto extraído del PDF:\n\n${extractedText.slice(0, 35000)}`
          : `Analiza cuidadosamente este documento PDF clínico adjunto y extrae toda la información estructurada solicitada de acuerdo con las especificaciones.`;

        try {
          const aiResponse = await generateAiJsonResponse({
            systemPrompt: promptByCategory[category],
            userPrompt: userPromptText,
            imageBase64: documentContent,
            imageMimeType: 'application/pdf',
            temperature: 0.1,
          });
          if (aiResponse?.parsed) {
            parsed = aiResponse.parsed;
          }
        } catch (aiErr) {
          console.warn('[harbor-agent :pdfTool] Error en generateAiJsonResponse:', aiErr);
        }


        if (parsed) {
          const finalCategory = parsed.documentCategory || category;

          let domainMismatch = false;
          let domainMismatchReason = '';
          const reqTypeLower = (documentType || '').toLowerCase().trim();
          const isExplicitExpected = ['laboratory', 'lab', 'radiology', 'xray', 'mri', 'ct', 'wearable', 'fitness', 'apple_health', 'apple_ecg', 'ecg'].includes(reqTypeLower);

          if (isExplicitExpected) {
            let expectedNorm = 'laboratory';
            if (['radiology', 'xray', 'mri', 'ct'].includes(reqTypeLower)) expectedNorm = 'radiology';
            else if (['wearable', 'fitness'].includes(reqTypeLower)) expectedNorm = 'wearable';
            else if (['apple_health', 'health'].includes(reqTypeLower)) expectedNorm = 'apple_health';
            else if (['apple_ecg', 'ecg'].includes(reqTypeLower)) expectedNorm = 'apple_ecg';

            if (finalCategory !== expectedNorm) {
              domainMismatch = true;
              const categoryLabels: Record<string, string> = {
                radiology: 'Radiología e Imagenología',
                laboratory: 'Laboratorio Clínico',
                wearable: 'Dispositivos Wearables / Entrenamientos',
                apple_health: 'Biometría Pasiva Apple Health',
                apple_ecg: 'Electrocardiograma Apple Watch',
              };
              const detectedName = categoryLabels[finalCategory] || finalCategory;
              const expectedName = categoryLabels[expectedNorm] || expectedNorm;
              domainMismatchReason = `El documento PDF subido corresponde a ${detectedName}, no a ${expectedName}. Esto no va aquí, prueba subirlo con otra opción en la sección correspondiente.`;
            }
          }

          let llmObservations = parsed.observations || [];
          let llmLaboratoryData = parsed.laboratoryData;

          if (finalCategory === 'laboratory') {
            llmObservations = synchronizeLaboratoryObservations(llmLaboratoryData, llmObservations);
          }

          // Si el LLM devolvió un arreglo vacío o paneles vacíos, respaldar con el extractor local desacoplado
          if (finalCategory === 'laboratory' && (!llmObservations || llmObservations.length === 0)) {
            console.log('[harbor-agent :pdfTool] ⚠️ El LLM entregó 0 observaciones. Aplicando respaldo de extractor local determinista sobre texto OCR...');
            const labRes = extractLaboratoryLocally(extractedText);
            llmLaboratoryData = labRes.laboratoryData;
            llmObservations = synchronizeLaboratoryObservations(llmLaboratoryData, labRes.observations);
          }

          return {
            status: 'success',
            capabilityCode: 'health_pdf_extraction',
            documentType: finalCategory,
            documentCategory: finalCategory,
            domainMismatch,
            domainMismatchReason,
            extractedText: extractedText || 'Texto transcrito desde capa digital de PDF.',
            pdfProcessing: {
              totalPages: pdfPages.length,
              nativeTextPages: Math.max(0, pdfPages.length - pagesReadWithOcr),
              ocrPages: pagesReadWithOcr,
            },
            radiologyData: parsed.radiologyData,
            laboratoryData: llmLaboratoryData,
            wearableData: parsed.wearableData,
            appleHealthData: parsed.appleHealthData,
            appleECGData: parsed.appleECGData,
            observations: llmObservations,
            extractedAt: new Date().toISOString(),
            disclaimer: 'Extracción de PDF procesada mediante visión OCR y estructuración multimodal.',
          };
        }
      } catch (err) {
        console.warn('[harbor-agent :pdfTool] Error en estructuración con LLM:', err);
      }
    }

    // Fallback determinista local por módulo extractor si no hay API Key de OpenAI
    console.log(`[harbor-agent :pdfTool] ⚡ Aplicando extractor local para PDF en categoría: ${category}...`);

    let radiologyData: RadiologyExtractionResult | undefined;
    let laboratoryData: LaboratoryExtractionResult | undefined;
    let wearableData: WearableExtractionResult | undefined;
    let appleHealthData: AppleHealthPassiveBiometrics | undefined;
    let appleECGData: AppleECGExtractionResult | undefined;
    let observations: StructuredObservation[] = [];

    if (category === 'laboratory') {
      const labRes = extractLaboratoryLocally(extractedText);
      laboratoryData = labRes.laboratoryData;
      observations = labRes.observations;
    } else if (category === 'wearable') {
      const wearRes = extractWearableLocally(extractedText);
      wearableData = wearRes.wearableData;
    } else if (category === 'apple_health') {
      const ahRes = extractAppleHealthLocally(extractedText);
      appleHealthData = ahRes.appleHealthData;
    } else if (category === 'apple_ecg') {
      const ecgRes = extractAppleECGLocally(extractedText);
      appleECGData = ecgRes.appleECGData;
    }

    let domainMismatch = false;
    let domainMismatchReason = '';

    const reqTypeLower = (documentType || '').toLowerCase().trim();
    const isExplicitExpected = ['laboratory', 'lab', 'radiology', 'xray', 'mri', 'ct', 'wearable', 'fitness', 'apple_health', 'apple_ecg', 'ecg'].includes(reqTypeLower);

    if (isExplicitExpected) {
      let expectedNorm = 'laboratory';
      if (['radiology', 'xray', 'mri', 'ct'].includes(reqTypeLower)) expectedNorm = 'radiology';
      else if (['wearable', 'fitness'].includes(reqTypeLower)) expectedNorm = 'wearable';
      else if (['apple_health', 'health'].includes(reqTypeLower)) expectedNorm = 'apple_health';
      else if (['apple_ecg', 'ecg'].includes(reqTypeLower)) expectedNorm = 'apple_ecg';

      if (category !== expectedNorm) {
        domainMismatch = true;
        const categoryLabels: Record<string, string> = {
          radiology: 'Radiología e Imagenología',
          laboratory: 'Laboratorio Clínico',
          wearable: 'Dispositivos Wearables / Entrenamientos',
          apple_health: 'Biometría Pasiva Apple Health',
          apple_ecg: 'Electrocardiograma Apple Watch',
        };
        const detectedName = categoryLabels[category] || category;
        const expectedName = categoryLabels[expectedNorm] || expectedNorm;
        domainMismatchReason = `El documento PDF subido corresponde a ${detectedName}, no a ${expectedName}. Esto no va aquí, prueba subirlo con otra opción en la sección correspondiente.`;
      }
    }

    return {
      status: 'success',
      capabilityCode: 'health_pdf_extraction',
      documentType: category,
      documentCategory: category,
      domainMismatch,
      domainMismatchReason,
      extractedText: extractedText || 'Texto transcrito desde PDF.',
      pdfProcessing: {
        totalPages: pdfPages.length,
        nativeTextPages: Math.max(0, pdfPages.length - pagesReadWithOcr),
        ocrPages: pagesReadWithOcr,
      },
      radiologyData,
      laboratoryData,
      wearableData,
      appleHealthData,
      appleECGData,
      observations,
      extractedAt: new Date().toISOString(),
      disclaimer: `Extracción desacoplada mediante pdfTool local (${category}).`,
    };
  },
});
