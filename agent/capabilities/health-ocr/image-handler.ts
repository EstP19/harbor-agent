import { generateAiJsonResponse } from '../../../lib/ai-provider.ts';

const systemPrompt = `Analiza detalladamente la siguiente imagen de salud (informe de laboratorio en neerlandés/español/inglés, reporte de radiología, pantalla de Apple Health o wearable) y extrae de forma estructurada cada fila o hallazgo:

1. "rawText": Todo el texto legible transcrito fielmente en su idioma original.
2. "documentCategory": Categoría ("laboratory", "radiology", "wearable", "general_health").
3. "observations": Arreglo de cada una de las observaciones o filas extraídas del reporte:
   - Para INFORMES DE LABORATORIO (mapea cabeceras como Test, Resultaat, Eenheid, Referentiewaarde, Parameter, Result, Units, Reference Range):
     * "literalMarker": Nombre del examen/test (ej. "WBC", "RBC", "HGB", "HCT", "Trombocyten", "Granulocyten#", "Bezinking", "CRP").
     * "numericValue": Valor numérico extraído de la columna Resultaat / Resultado (ej. 9.69, 4.95, 15.0, 44.6, 772, 6.02, 10, 0.2).
     * "unitCode": Unidad de la columna Eenheid / Unit (ej. "10*9/L", "10*12/L", "g/dL", "%", "mm/uur", "mg/dL").
     * "literalUnit": Unidad tal como aparece en el texto.
     * "printedFlag": "HIGH" si hay indicador H/Elevado, "LOW" si hay L/Bajo, "ABNORMAL" si hay asterisco/anormalidad, o "NORMAL".
     * "lowerBound": Límite inferior del rango Referentiewaarde como número (ej. 4.23, 4.63, 13.7, 40.1, 163, 1.78, 0).
     * "upperBound": Límite superior del rango Referentiewaarde como número (ej. 9.07, 6.08, 17.5, 51, 337, 5.38, 10, 0.5).
     * "rangeText": Rango impreso completo de Referentiewaarde (ej. "4.23 - 9.07 10*9/L", "163 - 337 10*9/L").
     * "confidence": 0.98

   - Para RADIOLOGÍA:
     * "literalMarker": Procedimiento o hallazgo (ej. "XR KNEE RT - Osteoarthritic changes", "Calcific Enthesopathy", "Lateral Meniscal Extrusion").
     * "numericValue": Medida en mm/cm si aplica (ej. 15.7, 6.3).
     * "unitCode": "MM" o "CM".
     * "printedFlag": "ABNORMAL" o "HIGH".
     * "confidence": 0.95

   - Para WEARABLES / APPLE HEALTH:
     * "literalMarker": Métrica (ej. "Resting Heart Rate", "Indoor Run Distance", "Active Calories", "Avg Heart Rate").
     * "numericValue": Valor de la pantalla (ej. 67, 3.30, 253, 134).
     * "unitCode": "BPM", "KM", "CAL".
     * "confidence": 0.98

Responde ÚNICAMENTE un objeto JSON válido con las claves: rawText, documentCategory, observations.`;

export async function handleHealthImageOcr(input: {
  documentContent: string;
  documentType?: string;
  mimeType?: string;
}) {
  const dataUrlMimeType = input.documentContent.match(/^data:(image\/[^;,]+);base64,/i)?.[1];
  const result = await generateAiJsonResponse({
    provider: 'openai',
    systemPrompt,
    userPrompt: 'Transcribe la imagen adjunta y devuelve el resultado como JSON.',
    imageBase64: input.documentContent,
    imageMimeType: dataUrlMimeType || input.mimeType,
    temperature: 0.1,
  });

  if (!result?.parsed || typeof result.parsed !== 'object' || Array.isArray(result.parsed)) {
    return null;
  }

  const { rawText, documentCategory, observations } = result.parsed;
  return {
    status: 'success',
    capabilityCode: 'health_ocr',
    documentType: input.documentType,
    documentCategory: documentCategory || 'general_health',
    extractedText: rawText || 'Texto transcrito por visión OCR.',
    observations: Array.isArray(observations) ? observations : [],
    extractedAt: new Date().toISOString(),
    disclaimer: 'Extracción visión OCR multimodal realizada sin juicio clínico.',
  };
}
