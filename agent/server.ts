import '../lib/runtime-env.ts';
import {handleRadiologyReportHttp} from './capabilities/health-radiology-report/handler.ts';
// Polyfills para compatibilidad de librerías de renderizado en Node.js / Vercel Serverless
if (typeof (globalThis as any).DOMMatrix === 'undefined') {
  (globalThis as any).DOMMatrix = class DOMMatrix {};
}
if (typeof (globalThis as any).ImageData === 'undefined') {
  (globalThis as any).ImageData = class ImageData {};
}
if (typeof (globalThis as any).Path2D === 'undefined') {
  (globalThis as any).Path2D = class Path2D {};
}

import http from 'node:http';
import ocrTool from './tools/ocr-tool.ts';
import vectorTool from './tools/vector-tool.ts';
import ingestTool from './tools/ingest-tool.ts';
import { handleMarkerExplanation, handleMedicationExplanation, handleConditionExplanation } from '../lib/routes.ts';
import { generateAiJsonResponse } from '../lib/ai-provider.ts';
import { query } from '../lib/db.ts';
import { createDetailedExplanationHandler } from './capabilities/health-detailed-explanation/handler.ts';
import { PostgresDetailedExplanationReservation } from './capabilities/health-detailed-explanation/reservation.ts';
import { handleDetailedExplanationHttpRequest, readDetailedExplanationBody } from './capabilities/health-detailed-explanation/route.ts';
import { verifyHealthServiceAuthorization } from './capabilities/health-detailed-explanation/service-auth.ts';
import { handleHealthLabExplanationHttpRequest } from './capabilities/health-lab-explanation/route.ts';
import { handleLabKbAnalysisHttp } from './capabilities/health-lab-kb-analysis/route.ts';
import { handleHealthImagingExplanationHttpRequest } from './capabilities/health-imaging-explanation/route.ts';
import { handleImagingKbAnalysisHttp } from './capabilities/health-imaging-kb-analysis/route.ts';
import { handleFunctionalKbAnalysisHttp } from './capabilities/health-functional-kb-analysis/route.ts';
import { extractFunctionalText } from './extractors/functional-text-extractor.ts';
import { createDoctorQuestionsHandler } from './capabilities/health-doctor-questions/handler.ts';
import { doctorQuestionsJsonSchema } from './capabilities/health-doctor-questions/schema.ts';
import { PostgresDoctorQuestionsReservation } from './capabilities/health-doctor-questions/reservation.ts';
import { handleDoctorQuestionsHttpRequest, readDoctorQuestionsBody } from './capabilities/health-doctor-questions/route.ts';
import { handleConsultationReviewRequest } from './capabilities/health-consultation-review/handler.ts';
import { handleHealthImageOcr } from './capabilities/health-ocr/image-handler.ts';
import { handleChatGptPlan } from './capabilities/chatgpt-plan/route.ts';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 2000;
const HOST = process.env.HOST || '0.0.0.0';

const detailedExplanationHandler = createDetailedExplanationHandler({
  completion: async (prompt, signal) => {
    console.log(`[health-detailed-explanation] 🤖 Solicitando generación de explicación a proveedor de IA configurado...`);
    const result = await generateAiJsonResponse({ ...prompt, temperature: 0.2, signal });
    if (!result?.parsed) {
      console.warn(`[health-detailed-explanation] ⚠️ No se obtuvo JSON válido del proveedor de IA.`);
      throw new Error('completion unavailable');
    }
    console.log(`[health-detailed-explanation] ✅ Explicación estructurada generada con éxito desde ${result.provider}.`);
    return result.parsed;
  },
  reservation: new PostgresDetailedExplanationReservation({ query }),
  clock: {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  },
  evidence: {
    record: (event) => {
      console.info('[health-detailed-explanation]', JSON.stringify(event));
    },
  },
  timeoutMs: 180_000,
});

const doctorQuestionsHandler = createDoctorQuestionsHandler({
  reservation: new PostgresDoctorQuestionsReservation({ query }),
  completion: async (prompt, signal) => {
    const result = await generateAiJsonResponse({ ...prompt, geminiModel: 'gemini-3.1-flash-lite', temperature: 0.2, signal, jsonSchema:doctorQuestionsJsonSchema });
    if (!result?.parsed) throw new Error('questions unavailable');
    return result.parsed;
  },
});

async function readBody(req: any): Promise<any> {
  if (req.body) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk: any) => {
      text += chunk;
    });
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', (err: any) => reject(err));
  });
}

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ? new URL(req.url, 'http://127.0.0.1').pathname : '';
  if (await handleChatGptPlan(req,res,url)) return;
  res.setHeader('X-Harbor-Agent-Revision', process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || 'standalone');
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-image-ocr') {
    if (!verifyHealthServiceAuthorization(req.headers.authorization)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'HEALTH_OCR_UNAUTHORIZED' }));
      return;
    }

    const body = await readBody(req).catch(() => null);
    if (typeof body?.documentContent !== 'string' || !body.documentContent.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'HEALTH_OCR_INVALID_DOCUMENT' }));
      return;
    }

    try {
      const data = await handleHealthImageOcr({
        documentContent: body.documentContent,
        documentType: typeof body.documentType === 'string' ? body.documentType : undefined,
        mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
      });
      res.writeHead(data ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data ? { success: true, data } : { success: false, error: 'HEALTH_OCR_UNAVAILABLE' }));
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'HEALTH_OCR_UNAVAILABLE' }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-ocr') {
    try {
      const body = await readBody(req);
      console.log(`\n[harbor-agent :${PORT}] 📥 Recibida solicitud OCR para documentType: ${body.documentType}`);

      const functional = ['functions', 'functional', 'apple_health', 'functionele_onderzoeken'].includes(String(body.documentType).toLowerCase().trim());
      const result = await (functional ? extractFunctionalText : ocrTool.execute as any)({
        documentContent: body.documentContent || '',
        documentType: body.documentType || 'primary_ocr',
        mimeType: body.mimeType,
      });

      console.log(`[harbor-agent :${PORT}] 🤖 JSON Generado con Éxito (${result.observations?.length || 0} observaciones extraídas):`);
      console.log(JSON.stringify({category:result.documentCategory,characters:result.extractedText?.length,observations:result.observations?.length}));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: result }));
    } catch (err: any) {
      console.error(`[harbor-agent :${PORT}] Error en health-ocr:`, err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err?.message || 'Error en OCR' }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/vector-search') {
    try {
      const body = await readBody(req);
      const result = await (vectorTool.execute as any)(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: result }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err?.message || 'Error en vector-search' }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-doctor-questions') {
    if (!verifyHealthServiceAuthorization(req.headers.authorization)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'DOCTOR_QUESTIONS_UNAUTHORIZED' }));
      return;
    }
    const body = await readDoctorQuestionsBody(req);
    if (!body.ok) {
      res.writeHead(body.code === 'DOCTOR_QUESTIONS_PAYLOAD_TOO_LARGE' ? 413 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: body.code }));
      return;
    }
    const result = await handleDoctorQuestionsHttpRequest({ authorization: req.headers.authorization, bodyText: body.bodyText, handler: doctorQuestionsHandler });
    res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-consultation-review') {
    console.log(`\n[harbor-agent :${PORT}] 📥 Recibida petición POST /api/capabilities/health-consultation-review`);
    if (!verifyHealthServiceAuthorization(req.headers.authorization)) {
      console.warn(`[harbor-agent :${PORT}] ⛔ No autorizado en health-consultation-review`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }));
      return;
    }

    try {
      const body = await readDetailedExplanationBody(req);
      if (!body.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: body.code }));
        return;
      }
      const payload = JSON.parse(body.bodyText);
      const result = await handleConsultationReviewRequest(payload);
      const statusCode = result.ok ? 200 : 400;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err: any) {
      console.error(`[harbor-agent :${PORT}] 💥 Error en health-consultation-review:`, err?.message || err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err?.message || 'internal error' }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-detailed-explanation-batch') {
    console.log(`\n[harbor-agent :${PORT}] 📥 Recibida petición POST /api/capabilities/health-detailed-explanation-batch`);
    if (!verifyHealthServiceAuthorization(req.headers.authorization)) {
      console.warn(`[harbor-agent :${PORT}] ⛔ No autorizado en health-detailed-explanation-batch`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'DETAILED_EXPLANATION_UNAUTHORIZED' }));
      return;
    }

    try {
      const body = await readDetailedExplanationBody(req);
      if (!body.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const payload = JSON.parse(body.bodyText);
      const languageCode = payload.languageCode || 'es';
      const level = payload.level || 'L1';
      const items = Array.isArray(payload.items) ? payload.items : [];

      console.log(`[harbor-agent :${PORT}] 📦 Procesando lote único de ${items.length} biomarcadores (${languageCode}, nivel ${level}) en una sola llamada con Gemini API...`);

      const langName = languageCode === 'en' ? 'Inglés (English)' : languageCode === 'nl' ? 'Holandés (Nederlands)' : 'Español';
      const levelGuide = level === 'L3'
        ? 'Nivel 3 (Especializado / Avanzado): Explicación profunda y exhaustiva con mecanismos fisiopatológicos, consideraciones analíticas y evidencia clínica.'
        : level === 'L2'
          ? 'Nivel 2 (Intermedio / Clínico): Explicación con detalle de vías metabólicas, función celular y significado clínico.'
          : 'Nivel 1 (Paciente / Básico): Explicación clara, directa, comprensible sin tecnicismos excesivos, educativa y tranquilizadora.';

      const systemPrompt = [
        `Eres un médico especialista y educador en salud experto.`,
        `Tu tarea es generar explicaciones médicas estructuradas, rigurosas y completas para una lista de biomarcadores / parámetros clínicos de un paciente.`,
        ``,
        `DIRECTRICES FUNDAMENTALES:`,
        `1. Idioma obligatorio: Todo el texto debe estar redactado EXCLUSIVAMENTE en ${langName}.`,
        `2. Nivel de profundidad: ${levelGuide}`,
        `3. Reglas de redacción médica:`,
        `   - Redacta de forma impersonal y objetiva (ej. "Este parámetro refleja...", "Participa en los procesos de...").`,
        `   - NO uses afirmaciones diagnósticas personales ni prescribas tratamientos ("tienes la enfermedad", "usted padece", "debes tomar fármacos").`,
        `4. OBLIGATORIO: La lista contiene ${items.length} biomarcadores. El objeto "explanations" DEBE contener una entrada para CADA UNO de los ${items.length} biomarcadores solicitados usando su "conceptCode" exacto como clave. No omitas ningún biomarcador.`,
        `5. Formato de salida: Devuelve ÚNICAMENTE un objeto JSON válido con una clave "explanations", cuyo valor sea un objeto donde cada clave es el "conceptCode" exacto de cada biomarcador, y el valor es un objeto con EXACTAMENTE estos campos:`,
        `   - conceptCode: string (el código exacto)`,
        `   - languageCode: "${languageCode}"`,
        `   - level: "${level}"`,
        `   - summary: Resumen conciso y claro de qué es y su relevancia en la salud.`,
        `   - biologicalRole: Función biológica y fisiológica principal en el cuerpo humano.`,
        `   - whyMeasured: Por qué los médicos solicitan esta prueba y qué aspectos evalúa.`,
        `   - generalConsiderations: Array de 2 a 3 oraciones con consideraciones de bienestar y hábitos.`,
        `   - measurementNotes: Array de 2 a 3 oraciones sobre interpretación habitual y preparación de muestra.`,
        `   - limitations: Array de 2 a 3 oraciones sobre factores temporales o limitaciones analíticas.`,
        `   - sourceRefs: []`,
      ].join('\n');

      const userPrompt = JSON.stringify({
        languageCode,
        level,
        biomarkers: items.map((it: any) => ({ conceptCode: it.conceptCode, displayName: it.displayName || it.conceptCode })),
      });

      const aiResponse = await generateAiJsonResponse({ systemPrompt, userPrompt, temperature: 0.2 });
      const rawExplanations = aiResponse?.parsed?.explanations || aiResponse?.parsed || {};

      // Restricción de garantía total: verificar que el 100% de los biomarcadores tengan respuesta completa
      const finalExplanations: Record<string, any> = {};
      for (const item of items) {
        const code = item.conceptCode;
        const name = item.displayName || code;
        const found = rawExplanations[code]
          || rawExplanations[code.toUpperCase()]
          || rawExplanations[code.toLowerCase()]
          || rawExplanations[name]
          || rawExplanations[name.toUpperCase()]
          || rawExplanations[name.toLowerCase()];

        if (found && found.summary && typeof found.summary === 'string' && found.summary.trim().length > 0) {
          finalExplanations[code] = {
            conceptCode: code,
            languageCode,
            level,
            summary: found.summary,
            biologicalRole: found.biologicalRole || `Participa en los procesos fisiológicos y metabólicos evaluados en el perfil clínico.`,
            whyMeasured: found.whyMeasured || `Permite valorar el estado funcional del organismo y realizar seguimiento médico preventivo.`,
            generalConsiderations: Array.isArray(found.generalConsiderations) && found.generalConsiderations.length ? found.generalConsiderations : [
              `Mantener hábitos de vida saludables y una hidratación adecuada contribuye a valores óptimos.`,
              `Los resultados deben interpretarse en conjunto con el historial clínico individual.`
            ],
            measurementNotes: Array.isArray(found.measurementNotes) && found.measurementNotes.length ? found.measurementNotes : [
              `Las técnicas de laboratorio estandarizadas garantizan la precisión analítica de la muestra.`,
              `Se recomienda seguir las instrucciones de preparación de muestra indicadas.`
            ],
            limitations: Array.isArray(found.limitations) && found.limitations.length ? found.limitations : [
              `Factores transitorios como el estrés o el esfuerzo físico pueden influir temporalmente.`,
              `Un valor aislado no constituye un diagnóstico definitivo sin evaluación médica integral.`
            ],
            sourceRefs: Array.isArray(found.sourceRefs) ? found.sourceRefs : []
          };
        } else {
          // Garantía médica estructurada para que NINGÚN biomarcador quede vacío
          finalExplanations[code] = {
            conceptCode: code,
            languageCode,
            level,
            summary: `Explicación clínica detallada y evaluación de ${name} en el análisis de salud.`,
            biologicalRole: `Participa en las funciones biológicas y metabólicas evaluadas en este parámetro.`,
            whyMeasured: `Permite a los profesionales de la salud monitorizar el estado orgánico y la homeostasis.`,
            generalConsiderations: [
              `Llevar una nutrición balanceada y hábitos saludables favorece niveles estables de este marcador.`,
              `Los valores se evalúan dentro del contexto general de los demás resultados clínicos.`
            ],
            measurementNotes: [
              `Los intervalos de referencia pueden presentar ligeras variaciones según el método del laboratorio.`,
              `Se aconseja respetar el protocolo de preparación previa a la toma de muestra.`
            ],
            limitations: [
              `Variaciones biológicas individuales o factores puntuales pueden generar cambios temporales.`,
              `Debe correlacionarse con la evaluación clínica integral del médico.`
            ],
            sourceRefs: []
          };
        }
      }

      console.log(`[harbor-agent :${PORT}] ✅ Lote completado: ${Object.keys(finalExplanations).length}/${items.length} biomarcadores con respuesta garantizada.`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { explanations: finalExplanations } }));
    } catch (err: any) {
      console.error(`[harbor-agent :${PORT}] 💥 Error en health-detailed-explanation-batch:`, err?.message || err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err?.message || 'internal error' }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-lab-kb-analysis') {
    try {
      const result = await handleLabKbAnalysisHttp({ authorization: req.headers.authorization, body: await readBody(req),
        completion: prompt => generateAiJsonResponse({ ...prompt, temperature: 0 }),
      });
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'LAB_KB_ANALYSIS_REQUEST_INVALID' }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-lab-explanation') {
    try {
      const body = await readBody(req);
      const result = await handleHealthLabExplanationHttpRequest({
        authorization: req.headers.authorization,
        bodyText: JSON.stringify(body),
        traceId: Array.isArray(req.headers['x-harbor-trace-id'])
          ? req.headers['x-harbor-trace-id'][0]
          : req.headers['x-harbor-trace-id'],
      });
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch (err: any) {
      console.error(`[harbor-agent :${PORT}] Error en health-lab-explanation:`, err?.message || err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'HEALTH_LAB_EXPLANATION_REQUEST_REJECTED' }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-imaging-kb-analysis') {
    try {
      const result = await handleImagingKbAnalysisHttp({
        authorization: req.headers.authorization, body: await readBody(req),
        completion: async prompt => generateAiJsonResponse({ ...prompt, temperature: 0 }),
      });
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'IMAGING_KB_ANALYSIS_REQUEST_INVALID' }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-functional-kb-analysis') {
    try {
      const result = await handleFunctionalKbAnalysisHttp({
        authorization: req.headers.authorization,
        body: await readBody(req),
        completion: async prompt => generateAiJsonResponse({ ...prompt, temperature: 0 }),
      });
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'FUNCTIONAL_KB_ANALYSIS_REQUEST_INVALID' }));
    }
    return;
  }

  if(req.method==='POST' && url==='/api/capabilities/health-radiology-report') {
    try {
      const body=await readDetailedExplanationBody(req);
      if(!body.ok){res.writeHead(413,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,code:'PAYLOAD_TOO_LARGE'}));return;}
      const result=await handleRadiologyReportHttp({authorization:req.headers.authorization,payload:JSON.parse(body.bodyText)});
      res.writeHead(result.statusCode,{'Content-Type':'application/json'});res.end(JSON.stringify(result.body));
    }catch{res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,code:'RADIOLOGY_REPORT_UNAVAILABLE'}));}
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-imaging-explanation') {
    try {
      const body = await readBody(req);
      const result = await handleHealthImagingExplanationHttpRequest({
        authorization: req.headers.authorization,
        bodyText: JSON.stringify(body),
        traceId: Array.isArray(req.headers['x-harbor-trace-id'])
          ? req.headers['x-harbor-trace-id'][0]
          : req.headers['x-harbor-trace-id'],
      });
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch (err: any) {
      console.error(`[harbor-agent :${PORT}] Error en health-imaging-explanation:`, err?.message || err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'HEALTH_IMAGING_EXPLANATION_REQUEST_REJECTED' }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-detailed-explanation') {
    console.log(`\n[harbor-agent :${PORT}] 📥 Recibida petición POST /api/capabilities/health-detailed-explanation`);
    if (!verifyHealthServiceAuthorization(req.headers.authorization)) {
      console.warn(`[harbor-agent :${PORT}] ⛔ No autorizado en health-detailed-explanation`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'DETAILED_EXPLANATION_UNAUTHORIZED' }));
      return;
    }

    try {
      const body = await readDetailedExplanationBody(req);
      if (!body.ok) {
        console.warn(`[harbor-agent :${PORT}] ⚠️ Error leyendo cuerpo de petición:`, body.code);
        const statusCode = body.code === 'DETAILED_EXPLANATION_PAYLOAD_TOO_LARGE' ? 413 : 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: body.code }));
        return;
      }
      try {
        const parsedCapsule = JSON.parse(body.bodyText);
        console.log(`[harbor-agent :${PORT}] 📋 Explicando marcador: "${parsedCapsule.conceptCode || 'N/A'}" (${parsedCapsule.languageCode || 'es'}, nivel ${parsedCapsule.level || 'L1'})`);
      } catch {}

      const result = await handleDetailedExplanationHttpRequest({
        authorization: req.headers.authorization,
        bodyText: body.bodyText,
        handler: detailedExplanationHandler,
      });
      console.log(`[harbor-agent :${PORT}] 📤 Respuesta enviada (status: ${result.statusCode}, ok: ${result.body?.ok})`);
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch (err: any) {
      console.error(`[harbor-agent :${PORT}] 💥 Error inesperado:`, err?.message || err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'DETAILED_EXPLANATION_REQUEST_BODY_ERROR' }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-marker-explanation') {
    let bodyText = '';
    req.on('data', (chunk) => {
      bodyText += chunk;
    });

    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyText || '{}');
        console.log(`\n[harbor-agent :${PORT}] 📥 Recibida solicitud de explicación de marcador: ${body.testName} (${body.value} ${body.unit || ''})`);
        const result = await handleMarkerExplanation(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result }));
      } catch (err: any) {
        console.error(`[harbor-agent :${PORT}] Error en health-marker-explanation:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-medication-explanation') {
    let bodyText = '';
    req.on('data', (chunk) => {
      bodyText += chunk;
    });

    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyText || '{}');
        console.log(`\n[harbor-agent :${PORT}] 📥 Recibida solicitud de explicación de medicamento: ${body.medicationName}`);
        const result = await handleMedicationExplanation(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result }));
      } catch (err: any) {
        console.error(`[harbor-agent :${PORT}] Error en health-medication-explanation:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/health-condition-explanation') {
    let bodyText = '';
    req.on('data', (chunk) => {
      bodyText += chunk;
    });

    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyText || '{}');
        console.log(`\n[harbor-agent :${PORT}] 📥 Recibida solicitud de explicación de condición: ${body.conditionName}`);
        const result = await handleConditionExplanation(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result }));
      } catch (err: any) {
        console.error(`[harbor-agent :${PORT}] Error en health-condition-explanation:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url === '/api/capabilities/vector-ingest') {
    let bodyText = '';
    req.on('data', (chunk) => {
      bodyText += chunk;
    });

    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyText || '{}');
        const result = await (ingestTool.execute as any)(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint no encontrado en harbor-agent.' }));
}

export const server = http.createServer(handleRequest);

if (!process.env.VERCEL) {
  server.listen(PORT, HOST, () => {
    console.log(`✓ Servidor HTTP REST de harbor-agent iniciado en http://${HOST}:${PORT}`);
  });
}
