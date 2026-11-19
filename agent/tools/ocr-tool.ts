import { defineTool } from '../../lib/tool-helper.ts';
import { z } from 'zod';
import { createWorker } from 'tesseract.js';
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
import pdfTool from './pdf-tool.ts';

export type DocumentCategory = 'radiology' | 'laboratory' | 'wearable' | 'apple_ecg' | 'apple_health';

function detectDocumentCategory(text: string, documentType?: string): DocumentCategory {
  const dt = (documentType || '').toLowerCase().trim();

  // Si el usuario seleccionó una categoría al subir la foto/documento o es 'other', mapear a apple_health
  if (dt === 'other' || dt === 'apple_health' || dt === 'applehealth' || dt === 'passive_biometrics' || dt.includes('apple') || dt === 'health') return 'apple_health';
  if (dt === 'wearable' || dt === 'fitness' || dt === 'garmin' || dt === 'strava' || dt === 'apple_fitness') return 'wearable';
  if (dt === 'apple_ecg' || dt === 'ecg') return 'apple_ecg';
  if (dt === 'radiology' || dt === 'xray' || dt === 'mri' || dt === 'ct') return 'radiology';
  if (dt === 'laboratory' || dt === 'lab' || dt === 'blood') return 'laboratory';

  const t = text.toUpperCase();

  // 1. Entrenamientos / Sesiones Deportivas (Wearable)
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

  // 2. Electrocardiogramas Apple Watch (Apple ECG)
  if (t.includes('ELECTROCARDIOGRAM') || t.includes('SINUS RHYTHM') || t.includes('ATRIAL FIBRILLATION')) {
    return 'apple_ecg';
  }

  // 3. Biometría Pasiva Longitudinal (Apple Health)
  if (
    t.includes('RESTING') ||
    t.includes('RESTING HEART RATE') ||
    t.includes('HEART RATE VARIABILITY') ||
    t.includes('VO2 MAX') ||
    t.includes('SLEEP ANALYSIS')
  ) {
    return 'apple_health';
  }

  // 4. Radiología
  if (t.includes('IMPRESSION') || t.includes('RADIUS') || t.includes('MRI') || t.includes('X-RAY') || t.includes('RADIOLOG')) {
    return 'radiology';
  }

  return 'laboratory';
}

export default defineTool({
  description:
    'Extrae texto e información estructurada desacoplada por categoría (radiología, laboratorio, wearables, apple_ecg, apple_health) usando OCR local Tesseract y estructuración con OpenAI.',
  inputSchema: z.object({
    documentContent: z
      .string()
      .describe('Representación Base64 o texto del documento/imagen.'),
    documentType: z
      .string()
      .default('primary_ocr')
      .describe('Tipo o categoría del documento.'),
    mimeType: z.string().optional(),
    forceOcr: z.boolean().optional(),
  }),
  async execute({ documentContent, documentType, mimeType, forceOcr }): Promise<any> {
    if (['radiology','xray','mri','ct'].includes((documentType || '').toLowerCase().trim())) {
      const {extractRadiologyText}=await import('../extractors/radiology-text-extractor.ts');
      return extractRadiologyText({documentContent,mimeType});
    }
    const trimmedContent = documentContent.trimStart();
    const isPdf =
      !forceOcr &&
      ((mimeType && mimeType.toLowerCase().includes('pdf') && mimeType !== 'image/scanned-pdf') ||
      trimmedContent.startsWith('data:application/pdf') ||
      trimmedContent.startsWith('%PDF-') ||
      trimmedContent.startsWith('JVBERi0'));

    if (isPdf) {
      console.log('[harbor-agent :ocrTool] 📑 Detectado documento PDF. Delegando a pdfTool...');
      return await (pdfTool.execute as any)({ documentContent, documentType, mimeType });
    }


    const isBase64Image =
      documentContent.startsWith('data:image/') ||
      (mimeType && mimeType.startsWith('image/'));

    let extractedText = '';

    if (isBase64Image) {
      if (!process.env.VERCEL) {
        try {
          console.log('[harbor-agent] 🔍 Ejecutando OCR local con Tesseract.js...');
          let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let expired = false;
          const tesseractPromise = (async () => {
            worker = await createWorker('spa+eng');
            try {
              if (expired) throw new Error('Tesseract timeout');
              return (await worker.recognize(documentContent)).data.text;
            } finally { await worker.terminate(); }
          })();
          const timeoutPromise = new Promise<string>((_, reject) => {
            timer = setTimeout(() => {
              expired = true;
              void worker?.terminate().catch(() => {});
              reject(new Error('Tesseract timeout'));
            }, 120_000);
          });
          try { extractedText = await Promise.race([tesseractPromise, timeoutPromise]); }
          finally { if (timer) clearTimeout(timer); }
          console.log(`[harbor-agent] ✓ OCR Local completado (${extractedText.length} caracteres transcritos).`);
        } catch (ocrErr) {
          console.warn('[harbor-agent] Omitiendo OCR Tesseract local, se usará visión multimodal:', (ocrErr as any)?.message);
          extractedText = '';
        }
      } else {
        console.log('[harbor-agent] 🌐 Entorno serverless detectado: usando Visión Multimodal directa.');
        extractedText = '';
      }
    } else {
      extractedText = documentContent;
    }

    const category = detectDocumentCategory(extractedText, documentType);
    if(category==='radiology') {
      const {extractRadiologyText}=await import('../extractors/radiology-text-extractor.ts');
      return extractRadiologyText({documentContent,mimeType});
    }
    console.log(`[harbor-agent] 🎯 Categoría médica/biométrica detectada: ${category.toUpperCase()}`);

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
      laboratory: `Eres un extractor experto de informes de laboratorio clínico. Extrae la información estructurada respetando fielmente el texto y la estructura del documento.
IMPORTANTE CRÍTICO:
1. El objeto 'laboratoryData.panels' debe contener TODOS los paneles o secciones detectadas con sus encabezados reales y la lista completa de resultados ('results').
2. El array 'observations' DEBE contener UNA ENTRADA POR CADA PRUEBA / RESULTADO presente en 'panels.results' (tanto normales como alterados). NUNCA omitas ni excluyas pruebas normales del array 'observations'.

Retorna exclusivamente un JSON válido con esta estructura:
{
  "documentCategory": "laboratory",
  "laboratoryData": {
    "printedLabName": "...", "patientName": "...", "reportDate": "...",
    "tableHeaders": ["Test", "Resultaat", "Eenheid", "Referentiewaarde"],
    "panels": [{"category": "Hematología", "headers": ["Test", "Resultaat", "Eenheid", "Referentiewaarde"], "results": [{"test_name": "WBC", "value": 9.69, "flag": "HIGH", "unit": "10*9/L", "reference_range": {"min": 4.23, "max": 9.07, "raw_text": "4.23-9.07"}}] }],
    "abnormal_results_summary": ["..."]
  },
  "observations": [{"literalMarker": "WBC", "numericValue": 9.69, "unitCode": "10*9/L", "literalUnit": "10*9/L", "printedFlag": "HIGH", "confidence": 0.98}]
}`,
      wearable: `Eres un agente experto de extracción de métricas de entrenamientos deportivos y wearables (Apple Fitness, Garmin, Strava). Retorna exclusivamente un JSON válido con esta estructura:
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
      apple_health: `Eres un agente experto de extracción de biometría pasiva de Apple Health (Resting Heart Rate, HRV, VO2 Max, Sueño). Lee la imagen/texto y extrae la métrica y el valor exacto de AVERAGE/PROMEDIO impreso en la imagen (por ejemplo, si aparece AVERAGE 67 o 67 BPM, el valor en summary.value debe ser 67). IMPORTANTE: NUNCA calcules o promedies números, extrae literalmente el número impreso. Retorna exclusivamente un JSON válido con esta estructura:
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
      apple_ecg: `Eres un extractor experto de electrocardiogramas de Apple Watch (Lead I). Retorna exclusivamente un JSON válido con esta estructura:
{
  "documentCategory": "apple_ecg",
  "appleECGData": {
    "analysis_type": "APPLE_WATCH_LEAD_1_ECG", "classification": "SINUS_RHYTHM", "rhythm_classification": "Sinus rhythm", "heart_rate_bpm": 68,
    "duration_s": 30, "sampling_rate": 512, "is_noisy": false, "electrical_axis_deviation": "Normal", "ecg_notes": ["No se detectó fibrilación auricular."]
  },
  "observations": [{"literalMarker": "Frecuencia Cardíaca ECG", "numericValue": 68, "unitCode": "BPM", "literalUnit": "BPM", "printedFlag": "NORMAL", "confidence": 0.99}]
}`
    };

    try {
      const userPromptText = extractedText && extractedText.trim().length > 10
        ? `Texto extraído por OCR:\n\n${extractedText.slice(0, 3500)}`
        : `Analiza cuidadosamente esta imagen clínica adjunta y extrae la información estructurada solicitada.`;

      const aiResult = await generateAiJsonResponse({
        systemPrompt: promptByCategory[category],
        userPrompt: userPromptText,
        imageBase64: isBase64Image ? documentContent : undefined,
        imageMimeType: mimeType || 'image/jpeg',
        temperature: 0.1,
        signal: AbortSignal.timeout(45_000),
      });

      if (aiResult?.parsed) {
        const parsed = aiResult.parsed;
        const finalCategory = parsed.documentCategory || category;

        // Garantizar sincronización completa entre panels.results y observations
        if (parsed.laboratoryData?.panels && Array.isArray(parsed.laboratoryData.panels)) {
          parsed.observations = synchronizeLaboratoryObservations(
            parsed.laboratoryData,
            Array.isArray(parsed.observations) ? parsed.observations : [],
          );
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
            domainMismatchReason = `El documento subido corresponde a ${detectedName}, no a ${expectedName}. Esto no va aquí, prueba subirlo con otra opción en la sección correspondiente.`;
          }
        }

        return {
          status: 'success',
          capabilityCode: 'health_ocr',
          documentType: finalCategory,
          documentCategory: finalCategory,
          domainMismatch,
          domainMismatchReason,
          extractedText: extractedText || 'Texto transcrito por OCR local Tesseract.js.',
          radiologyData: parsed.radiologyData,
          laboratoryData: parsed.laboratoryData,
          wearableData: parsed.wearableData,
          appleHealthData: parsed.appleHealthData,
          appleECGData: parsed.appleECGData,
          observations: parsed.observations || [],
          extractedAt: new Date().toISOString(),
          disclaimer: `Extracción procesada mediante OCR local Tesseract y estructuración especializada con proveedor de IA (${aiResult.provider}).`,
        };
      }
    } catch (err) {
      console.warn('[harbor-agent] Error en estructuración IA de OCR:', err);
    }

    // Paso 3: Fallback determinista local por extractor de módulo
    console.log(`[harbor-agent] ⚡ Aplicando extractor local desacoplado para categoría: ${category}...`);

    let radiologyData: RadiologyExtractionResult | undefined;
    let laboratoryData: LaboratoryExtractionResult | undefined;
    let wearableData: WearableExtractionResult | undefined;
    let appleHealthData: AppleHealthPassiveBiometrics | undefined;
    let appleECGData: AppleECGExtractionResult | undefined;
    let observations: StructuredObservation[] = [];

    if (category === 'laboratory') {
      const labRes = extractLaboratoryLocally(extractedText);
      laboratoryData = labRes.laboratoryData;
      observations = synchronizeLaboratoryObservations(laboratoryData, labRes.observations);
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

    // Validación de coincidencia de dominio (Domain Mismatch Check)
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
        domainMismatchReason = `El documento subido corresponde a ${detectedName}, no a ${expectedName}. Esto no va aquí, prueba subirlo con otra opción en la sección correspondiente.`;
      }
    }

    return {
      status: 'success',
      capabilityCode: 'health_ocr',
      documentType: category,
      documentCategory: category,
      domainMismatch,
      domainMismatchReason,
      extractedText: extractedText || 'Texto transcrito por OCR local Tesseract.js.',
      radiologyData,
      laboratoryData,
      wearableData,
      appleHealthData,
      appleECGData,
      observations,
      extractedAt: new Date().toISOString(),
      disclaimer: `Extracción desacoplada mediante extractor local (${category}).`,
    };
  },
});
