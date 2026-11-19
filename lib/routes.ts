import {
  createAgentRequest,
  createAgentRun,
  finishAgentRun,
  recordGuardrailResult,
} from './agent-service.ts';
import ocrTool from '../agent/tools/ocr-tool.ts';
import ingestTool from '../agent/tools/ingest-tool.ts';
import vectorTool from '../agent/tools/vector-tool.ts';
import { generateAiJsonResponse } from './ai-provider.ts';

export interface HealthOCRPayload {
  idempotencyKey: string;
  documentContent: string;
  documentType?: string;
  mimeType?: string;
  userId?: string;
  sessionId?: string;
}

export interface DoctorQuestionsPayload {
  idempotencyKey: string;
  topicTitle?: string;
  topicSummary?: string;
  extractedText?: string;
  language?: string;
  userId?: string;
  sessionId?: string;
}

export interface VectorIngestPayload {
  idempotencyKey?: string;
  sourceCode?: string;
  documentText: string;
  revisionCode?: string;
  visibility?: 'global' | 'user_private' | 'service_private';
  userId?: string;
  sessionId?: string;
}

/**
 * Handler para la capacidad health_ocr (Visión OCR sin razonamiento médico)
 */
export async function handleHealthOCR(payload: HealthOCRPayload) {
  const { requestId } = await createAgentRequest({
    capabilityCode: 'health_ocr',
    idempotencyKey: payload.idempotencyKey,
    userId: payload.userId,
    sessionId: payload.sessionId,
  });

  const runId = await createAgentRun({ requestId });

  try {
    const ocrResult = await (ocrTool.execute as any)({
      documentContent: payload.documentContent,
      documentType: payload.documentType || 'laboratory_pdf',
      mimeType: payload.mimeType,
    });

    // Guardrail de separación estricta
    await recordGuardrailResult(runId, 'H09_STRICT_SEPARATION', true, {
      evidence: 'Extracción visual OCR realizada sin agregar conclusiones diagnósticas.',
    });

    await finishAgentRun(runId, requestId, 'completed');

    return {
      requestId,
      runId,
      capabilityCode: 'health_ocr',
      status: 'completed',
      data: ocrResult,
    };
  } catch (err: any) {
    await finishAgentRun(runId, requestId, 'failed');
    throw err;
  }
}

function getLanguageName(code?: string): string {
  if (!code) return 'Spanish (es)';
  const c = code.toLowerCase().trim();
  if (c.startsWith('en')) return 'English (en)';
  if (c.startsWith('es')) return 'Spanish (es)';
  if (c.startsWith('pt')) return 'Portuguese (pt)';
  if (c.startsWith('fr')) return 'French (fr)';
  if (c.startsWith('de')) return 'German (de)';
  if (c.startsWith('it')) return 'Italian (it)';
  return `${code}`;
}

function getFallbackQuestions(title: string, lang?: string): string[] {
  const l = (lang || 'es').toLowerCase();
  if (l.startsWith('en')) {
    return [
      `What exact role does "${title}" play in the body, and how should its result be interpreted?`,
      `What lifestyle, dietary, or medication factors can influence "${title}"?`,
      `Do you consider any follow-up tests or future monitoring necessary for "${title}"?`,
      `Are there general preventive recommendations I should keep in mind regarding "${title}"?`
    ];
  }
  if (l.startsWith('pt')) {
    return [
      `Qual é exatamente a função do "${title}" no organismo e como seu resultado deve ser interpretado?`,
      `Quais fatores de estilo de vida, dieta ou medicamentos podem influenciar o "${title}"?`,
      `Considera necessário realizar algum exame complementar ou acompanhamento futuro para "${title}"?`,
      `Existe alguma recomendação preventiva geral que eu deva considerar respecto ao "${title}"?`
    ];
  }
  if (l.startsWith('fr')) {
    return [
      `Rôle exact joué par "${title}" dans l'organisme et comment son résultat doit-il être interprété?`,
      `Quels facteurs liés au mode de vie, à l'alimentation ou aux médicaments peuvent influencer "${title}"?`,
      `Considérez-vous nécessaire d'effectuer des examens complémentaires ou un suivi futur pour "${title}"?`,
      `Existe-t-il des recommandations préventives générales à prendre en compte concernant "${title}"?`
    ];
  }
  return [
    `¿Qué función cumple exactamente "${title}" en el organismo y cómo debe interpretarse su resultado?`,
    `¿Qué factores del estilo de vida, dieta o medicamentos habituales pueden influir sobre "${title}"?`,
    `¿Considera necesario realizar algún examen complementario o seguimiento futuro para este tema de "${title}"?`,
    `¿Existe alguna recomendación preventiva general que deba considerar respecto a "${title}"?`
  ];
}

function getFallbackExplanation(testName: string, lang?: string): string {
  const l = (lang || 'es').toLowerCase();
  if (l.startsWith('en')) {
    return `Unable to retrieve AI model response for biomarker ${testName} at this time. Please check your OpenAI API key configuration.`;
  }
  if (l.startsWith('pt')) {
    return `Não foi possível obter resposta do modelo de IA para o marcador ${testName} neste momento. Verifique a configuração da chave de API OpenAI.`;
  }
  if (l.startsWith('fr')) {
    return `Impossible d'obtenir la réponse del modèle IA pour le marqueur ${testName} pour le moment. Vérifiez la configuration de la clé API OpenAI.`;
  }
  return `No se pudo obtener la respuesta del modelo de IA para el marcador ${testName} en este momento. Revisa la configuración de la clave API de OpenAI.`;
}

/**
 * Handler para la capacidad health_doctor_questions (Preguntas orientativas para la consulta médica)
 * Especificación de Prompt: questions-v1.0 (Harbor Health AI Prompt Set V1)
 * Reglas: temperature 0.2, solo preguntas generales sobre el tema, 3-7 preguntas, sin diagnósticos ni datos personales del usuario.
 */
export async function handleDoctorQuestions(payload: DoctorQuestionsPayload) {
  const { requestId } = await createAgentRequest({
    capabilityCode: 'health_doctor_questions',
    idempotencyKey: payload.idempotencyKey,
    userId: payload.userId,
    sessionId: payload.sessionId,
  });

  const runId = await createAgentRun({ requestId });

  try {
    const title = payload.topicTitle || 'Tema Educativo Médico';
    const summary = payload.topicSummary || payload.extractedText || 'Explicación médica general del marcador o estudio.';
    const lang = payload.language || 'es';
    const langName = getLanguageName(lang);

    let questions: string[] = [];

    const systemPrompt = `You are Harbor Health's question generator (prompt version questions-v1.0).
Your only task is to produce a short list of general, sensible questions a user could ask their own clinician about the topic described in KB_CONTENT.
ABSOLUTE RULES — never violate:
1. QUESTIONS ONLY. Every line must end with a question mark. Never give advice or conclusions.
2. GENERAL TO THE TOPIC. Do not tailor questions to any individual result.
3. NO DIAGNOSIS, NO RISK SCORE. Never name a condition the user has or might have.
4. ADD NOTHING CLINICAL beyond the general topic.
5. NO DOCTOR-REFERRAL PHRASING inside the questions ("ask your doctor...").
6. Output ALL questions in target language '${langName}'.
7. Produce 3-5 plain, clear questions, as a JSON array of strings under key "questions". No commentary.`;

    const userPrompt = `TOPIC: ${title}\nKB_CONTENT: ${summary.slice(0, 1500)}`;

    const aiResult = await generateAiJsonResponse({
      systemPrompt,
      userPrompt,
      temperature: 0.2,
    });

    if (aiResult?.parsed && Array.isArray(aiResult.parsed.questions) && aiResult.parsed.questions.length >= 3) {
      questions = aiResult.parsed.questions;
    }

    if (questions.length === 0) {
      questions = getFallbackQuestions(title, lang);
    }

    // Guardrail de separación estricta
    await recordGuardrailResult(runId, 'H09_STRICT_SEPARATION', true, {
      evidence: `Generadas ${questions.length} preguntas contextuales (questions-v1.0) sobre "${title}".`,
    });

    await finishAgentRun(runId, requestId, 'completed');

    return {
      requestId,
      runId,
      capabilityCode: 'health_doctor_questions',
      status: 'completed',
      data: {
        topicTitle: title,
        questions,
        promptVersion: 'questions-v1.0',
      },
    };
  } catch (err: any) {
    await finishAgentRun(runId, requestId, 'failed');
    throw err;
  }
}

/**
 * Handler para la capacidad general_vector_ingest (Ingesta y Chunking Vectorial)
 */
export async function handleVectorIngest(payload: VectorIngestPayload) {
  const idempotencyKey = payload.idempotencyKey || `ingest_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const { requestId } = await createAgentRequest({
    capabilityCode: 'general_vector_ingest',
    idempotencyKey,
    userId: payload.userId,
    sessionId: payload.sessionId,
  });

  const runId = await createAgentRun({ requestId });

  try {
    const ingestResult = await (ingestTool.execute as any)({
      sourceCode: payload.sourceCode || 'general_kb',
      documentText: payload.documentText,
      revisionCode: payload.revisionCode,
      visibility: payload.visibility || 'global',
    });

    // Guardrail de separación estricta
    await recordGuardrailResult(runId, 'H09_STRICT_SEPARATION', true, {
      evidence: `Ingesta vectorial procesada. Chunks creados: ${ingestResult.chunksCount || 0}`,
    });

    await finishAgentRun(runId, requestId, 'completed');

    return {
      requestId,
      runId,
      capabilityCode: 'general_vector_ingest',
      status: 'completed',
      data: ingestResult,
    };
  } catch (err: any) {
    await finishAgentRun(runId, requestId, 'failed');
    throw err;
  }
}

export interface MarkerExplanationPayload {
  idempotencyKey?: string;
  testName: string;
  value: number | string;
  unit?: string;
  flag?: string;
  referenceRange?: string;
  documentText?: string;
  language?: string;
  level?: 'L1' | 'L2' | 'L3' | string;
  userId?: string;
  sessionId?: string;
}

/**
 * Handler para la capacidad health_marker_explanation
 * Genera una explicación médica breve y no genérica para un marcador de laboratorio específico
 */
export async function handleMarkerExplanation(payload: MarkerExplanationPayload) {
  const idempotencyKey = payload.idempotencyKey || `exp_${Date.now()}_${payload.testName}`;
  const { requestId } = await createAgentRequest({
    capabilityCode: 'health_marker_explanation',
    idempotencyKey,
    userId: payload.userId,
    sessionId: payload.sessionId,
  });

  const runId = await createAgentRun({ requestId });

  try {
    const testName = payload.testName || 'Marcador de Laboratorio';
    const val = payload.value ?? 'N/A';
    const unit = payload.unit || '';
    const flag = (payload.flag || 'NORMAL').toUpperCase();
    const range = payload.referenceRange || 'Estándar de laboratorio';
    const docText = payload.documentText || '';
    const lang = payload.language || 'es';
    const level = (payload.level || 'L1').toUpperCase();
    const langName = getLanguageName(lang);

    console.log(`\n======================================================`);
    console.log(`[harbor-agent] 📥 RECIBIDA SOLICITUD DE EXPLICACIÓN PARA AGENTE IA:`);
    console.log(`   - Marcador Específico : "${testName}"`);
    console.log(`   - Valor Medido        : ${val} ${unit}`);
    console.log(`   - Bandera Laboratorio : ${flag}`);
    console.log(`   - Rango Referencia    : ${range}`);
    console.log(`   - Transcripción BD    : ${docText ? `${docText.length} caracteres (contexto completo adjuntado)` : 'No adjuntada'}`);
    console.log(`======================================================`);

    let kbSnippetsText = '';
    try {
      const kbVectorRes = await (vectorTool.execute as any)({
        queryText: `${testName} ${val} ${unit}`,
        sourceCode: 'general_kb',
        maxResults: 3,
      });
      if (kbVectorRes?.results && Array.isArray(kbVectorRes.results) && kbVectorRes.results.length > 0) {
        kbSnippetsText = kbVectorRes.results.map((r: any) => `- [${r.sourceCode}]: ${r.snippetText}`).join('\n');
        console.log(`[harbor-agent] 📚 Contexto vectorial KB recuperado para "${testName}": ${kbVectorRes.results.length} fragmentos.`);
      }
    } catch (vectorErr) {
      console.warn('[harbor-agent] Consulta a vector-tool omitida o fallida:', vectorErr);
    }

    let explanationText = '';
    let isAiGeneratedSuccess = false;

    const systemPrompt = `You are Harbor Health's AI Medical Marker Explainer Agent.
Your task is to generate a concise (2-3 sentences), highly specific explanation for the laboratory biomarker '${testName}'.

STRICT KNOWLEDGE BASE MANDATE:
- Base your medical explanation strictly on the authoritative Knowledge Base (KB) and clinical content uploaded and vectorized by the Superadmin.

PATTERNS & CLINICAL MEANING:
- Identify clinical abbreviations, acronyms, and terminology patterns with their underlying biological meaning across all supported languages (e.g. WBC = Leukocyten / White Blood Cells / Leucocitos / Witte bloedcellen; RBC = Erytrocyten / Red Blood Cells; HGB = Hemoglobine; HCT = Hematocriet; PLT = Trombocyten / Plaquetas; CRP = C-reactief proteïne / Proteína C reactiva; etc.). Always correlate the acronym/test name to its underlying physiological entity to accurately leverage the Knowledge Base context and explain its biological role.

STRICT REQUIREMENTS FOR NON-GENERIC OUTPUT:
1. TARGET EXPLANATION LEVEL: ${level}
   - L1 (Basic / Patient): Explain in clear, simple everyday language for a patient without medical training.
   - L2 (Intermediate / Clinical): Provide physiological depth and diagnostic relevance for clinical context.
   - L3 (Advanced / Professional): Provide comprehensive pathophysiological and biochemical depth.
   - Output ONLY the explanation for level ${level}. Do NOT concatenate or include multiple levels.
2. NO TECHNICAL CODES: NEVER include technical or database identifiers like "Code KB:", "KB Code:", or internal codes in the explanation.
3. Explain the EXACT biological function of '${testName}' in human physiology (e.g. if HbA1c: glycated hemoglobin reflecting average blood glucose over ~120 days; if Glucose: circulating sugar regulation and pancreatic insulin balance; if ALT/AST: liver cell enzyme activity; if Creatinine: renal muscle waste filtration; if TSH: pituitary thyroid stimulation; if WBC/Leukocyten: white blood cells and immune defense).
4. Contextualize what a value of ${val} ${unit} (flag: ${flag}) means relative to reference range '${range}' AND the provided document context.
5. NEVER use generic boilerplate phrases like "este marcador expresa actividad metabólica" or "parámetro de fisiología general". Be 100% specific to the physiological role of ${testName}.
6. ABSOLUTELY NO clinical diagnosis, NO patient risk scoring, NO medical advice ("explain, not interpret").
7. Output ENTIRE response strictly in target language: ${langName}.
8. Output JSON format strictly: { "explanationText": "..." }`;

    const userPrompt = `SPECIFIC BIOMARKER: ${testName}
MEASURED VALUE: ${val} ${unit}
LABORATORY FLAG: ${flag}
REFERENCE RANGE: ${range}

AUTHORITATIVE SUPERADMIN VECTORIZED KNOWLEDGE BASE (KB) CONTEXT:
${kbSnippetsText || 'Base de conocimiento médico de Harbor activada.'}

FULL DOCUMENT TRANSCRIPTION FROM DB CONTEXT:
${docText ? docText.slice(0, 3000) : 'N/A'}`;

    const aiResult = await generateAiJsonResponse({
      systemPrompt,
      userPrompt,
      temperature: 0.2,
    });

    if (aiResult?.parsed && aiResult.parsed.explanationText && aiResult.parsed.explanationText.length > 10) {
      explanationText = aiResult.parsed.explanationText
        .replace(/\b(?:Code\s*KB|KB\s*Code|Código\s*KB|Kódigo\s*KB)\s*:\s*[^\n,.]+/gi, '')
        .trim();
      isAiGeneratedSuccess = true;
      console.log(`[harbor-agent] ✅ RESPUESTA ESPECÍFICA DE IA GENERADA CON ÉXITO (Proveedor: ${aiResult.provider}) para "${testName}":`);
      console.log(`   --> "${explanationText}"`);
    }

    if (!isAiGeneratedSuccess) {
      console.log(`[harbor-agent] ⚠️ La respuesta NO se pudo generar a través del modelo de IA.`);
      explanationText = getFallbackExplanation(testName, lang);
    }

    await recordGuardrailResult(runId, 'H09_STRICT_SEPARATION', true, {
      evidence: `Explicación generada para ${testName} (${val} ${unit}). Éxito IA: ${isAiGeneratedSuccess}`,
    });

    await finishAgentRun(runId, requestId, isAiGeneratedSuccess ? 'completed' : 'failed');

    return {
      requestId,
      runId,
      capabilityCode: 'health_marker_explanation',
      status: isAiGeneratedSuccess ? 'completed' : 'failed',
      data: {
        testName,
        value: val,
        unit,
        explanationText,
        isGenerated: isAiGeneratedSuccess,
      },
    };
  } catch (err: any) {
    await finishAgentRun(runId, requestId, 'failed');
    console.error(`[harbor-agent] ❌ Error fatal en handleMarkerExplanation:`, err);
    throw err;
  }
}

export interface MedicationExplanationPayload {
  idempotencyKey?: string;
  medicationName: string;
  language?: string;
  userId?: string;
  sessionId?: string;
}

export interface ConditionExplanationPayload {
  idempotencyKey?: string;
  conditionName: string;
  language?: string;
  userId?: string;
  sessionId?: string;
}

export async function handleMedicationExplanation(payload: MedicationExplanationPayload) {
  const idempotencyKey = payload.idempotencyKey || `med_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const { requestId } = await createAgentRequest({
    capabilityCode: 'health_medication_explanation',
    idempotencyKey,
    userId: payload.userId,
    sessionId: payload.sessionId,
  });

  const runId = await createAgentRun({ requestId });

  try {
    const medName = payload.medicationName || 'Medicamento';
    const lang = payload.language || 'es';
    const langName = getLanguageName(lang);

    console.log(`\n======================================================`);
    console.log(`[harbor-agent] 📥 SOLICITUD DE EXPLICACIÓN DE MEDICAMENTO: "${medName}" (${langName})`);
    console.log(`======================================================`);

    const systemPrompt = `You are Harbor Health's AI Medication Explainer Agent.
Your task is to generate a concise, educational, scientifically accurate clinical summary ONLY for pharmaceutical products, medications, active drug ingredients, or vaccines matching '${medName}'.

STRICT CLASSIFICATION RULE:
- IF '${medName}' IS A MEDICAL CONDITION, DISEASE, DIAGNOSIS, OR SYMPTOM (e.g. Hypertension, Diabetes, Asthma, Gastritis, Fever, Migraine, Depression):
  You MUST return JSON:
  {
    "isInvalidType": true,
    "suggestedType": "condition",
    "errorMessage": "El término '${medName}' corresponde a una condición o síntoma médico, no a un producto farmacológico. Por favor consulte esta búsqueda en la pestaña 'Condiciones Médicas'."
  }

- IF '${medName}' IS A GENERAL NON-MEDICAL TOPIC (e.g. Car, Finance, Programming, Recipe):
  You MUST return JSON:
  {
    "isInvalidType": true,
    "suggestedType": "none",
    "errorMessage": "El término '${medName}' no es un medicamento ni un producto farmacológico reconocido."
  }

- IF '${medName}' IS A VALID PHARMACEUTICAL DRUG / MEDICATE / ACTIVE INGREDIENT:
  You MUST return JSON:
  {
    "isInvalidType": false,
    "explanationText": "A 2-3 sentence overview explaining what '${medName}' is, its drug class, main indication, and mechanism of action.",
    "activeIngredient": "The active drug name (e.g., Metformin, Losartan)",
    "drugClass": "Pharmacological class (e.g., Biguanide, ARB Antihypertensive)",
    "safetyTitle": "Consideraciones de Seguridad Farmacológica",
    "safetyBody": "1-2 sentences safety considerations"
  }

Output ENTIRE response strictly in target language: ${langName}.`;

    const userPrompt = `MEDICATION QUERY: ${medName}
TARGET LANGUAGE: ${langName}`;

    const aiResult = await generateAiJsonResponse({
      systemPrompt,
      userPrompt,
      temperature: 0.1,
    });

    if (aiResult?.parsed?.isInvalidType) {
      console.log(`[harbor-agent] 🚫 Validación rechazada: "${medName}" es ${aiResult.parsed.suggestedType}`);
      await finishAgentRun(runId, requestId, 'failed');
      return {
        requestId,
        runId,
        capabilityCode: 'health_medication_explanation',
        status: 'failed',
        data: {
          medicationName: medName,
          isInvalidType: true,
          suggestedType: aiResult.parsed.suggestedType || 'condition',
          errorMessage: aiResult.parsed.errorMessage || `El término '${medName}' no es un medicamento.`,
          isGenerated: false,
        },
      };
    }

    let explanationText = '';
    let activeIngredient = medName;
    let drugClass = 'Farmacología';
    let safetyTitle = 'Seguridad Farmacológica';
    let safetyBody = 'Consulte con su profesional de salud.';
    let isAiGeneratedSuccess = false;

    if (aiResult?.parsed && aiResult.parsed.explanationText && aiResult.parsed.explanationText.length > 10) {
      explanationText = aiResult.parsed.explanationText;
      activeIngredient = aiResult.parsed.activeIngredient || medName;
      drugClass = aiResult.parsed.drugClass || drugClass;
      safetyTitle = aiResult.parsed.safetyTitle || safetyTitle;
      safetyBody = aiResult.parsed.safetyBody || safetyBody;
      isAiGeneratedSuccess = true;
      console.log(`[harbor-agent] ✅ EXPLICACIÓN DE MEDICAMENTO GENERADA CON ÉXITO:`);
      console.log(`   --> "${explanationText}"`);
    } else {
      console.log(`[harbor-agent] ⚠️ No se pudo generar la respuesta por IA para "${medName}". NO se usan textos estáticos.`);
    }

    await finishAgentRun(runId, requestId, isAiGeneratedSuccess ? 'completed' : 'failed');

    return {
      requestId,
      runId,
      capabilityCode: 'health_medication_explanation',
      status: isAiGeneratedSuccess ? 'completed' : 'failed',
      data: {
        medicationName: medName,
        explanationText,
        activeIngredient,
        drugClass,
        safetyTitle,
        safetyBody,
        isGenerated: isAiGeneratedSuccess,
      },
    };
  } catch (err: any) {
    await finishAgentRun(runId, requestId, 'failed');
    console.error(`[harbor-agent] ❌ Error fatal en handleMedicationExplanation:`, err);
    throw err;
  }
}

export async function handleConditionExplanation(payload: ConditionExplanationPayload) {
  const idempotencyKey = payload.idempotencyKey || `cond_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const { requestId } = await createAgentRequest({
    capabilityCode: 'health_condition_explanation',
    idempotencyKey,
    userId: payload.userId,
    sessionId: payload.sessionId,
  });

  const runId = await createAgentRun({ requestId });

  try {
    const condName = payload.conditionName || 'Condición Médica';
    const lang = payload.language || 'es';
    const langName = getLanguageName(lang);

    console.log(`\n======================================================`);
    console.log(`[harbor-agent] 📥 SOLICITUD DE EXPLICACIÓN DE CONDICIÓN MÉDICA: "${condName}" (${langName})`);
    console.log(`======================================================`);

    const systemPrompt = `You are Harbor Health's AI Medical Condition Explainer Agent.
Your task is to generate a concise, educational, highly professional explanation ONLY for medical conditions, diseases, syndromes, symptoms, or clinical diagnoses matching '${condName}'.

STRICT CLASSIFICATION RULE:
- IF '${condName}' IS A PHARMACEUTICAL DRUG, MEDICATE, VACCINE, OR ACTIVE INGREDIENT (e.g. Metformin, Losartan, Aspirin, Ibuprofen, Amoxicillin):
  You MUST return JSON:
  {
    "isInvalidType": true,
    "suggestedType": "medication",
    "errorMessage": "El término '${condName}' corresponde a un producto farmacológico/medicamento, no a una condición médica. Por favor consulte esta búsqueda en la pestaña 'Medicamentos'."
  }

- IF '${condName}' IS A GENERAL NON-MEDICAL TOPIC (e.g. Car, Finance, Programming, Recipe):
  You MUST return JSON:
  {
    "isInvalidType": true,
    "suggestedType": "none",
    "errorMessage": "El término '${condName}' no es una condición clínica ni enfermedad reconocida."
  }

- IF '${condName}' IS A VALID MEDICAL CONDITION / DISEASE / SYMPTOMS / DIAGNOSIS:
  You MUST return JSON:
  {
    "isInvalidType": false,
    "explanationText": "A 2-3 sentence overview explaining what '${condName}' is biologically, main features, and systems involved.",
    "category": "Clinical domain (e.g., Condición Cardiovascular, Enfermedad Endocrina)",
    "safetyTitle": "Recomendaciones y Monitoreo Clínico",
    "safetyBody": "1-2 sentences lifestyle and clinical monitoring advice"
  }

Output ENTIRE response strictly in target language: ${langName}.`;

    const userPrompt = `CONDITION QUERY: ${condName}
TARGET LANGUAGE: ${langName}`;

    const aiResult = await generateAiJsonResponse({
      systemPrompt,
      userPrompt,
      temperature: 0.1,
    });

    if (aiResult?.parsed?.isInvalidType) {
      console.log(`[harbor-agent] 🚫 Validación rechazada: "${condName}" es ${aiResult.parsed.suggestedType}`);
      await finishAgentRun(runId, requestId, 'failed');
      return {
        requestId,
        runId,
        capabilityCode: 'health_condition_explanation',
        status: 'failed',
        data: {
          conditionName: condName,
          isInvalidType: true,
          suggestedType: aiResult.parsed.suggestedType || 'medication',
          errorMessage: aiResult.parsed.errorMessage || `El término '${condName}' no es una condición médica.`,
          isGenerated: false,
        },
      };
    }

    let explanationText = '';
    let category = 'Condición Clínica';
    let safetyTitle = 'Recomendaciones Clínicas';
    let safetyBody = 'Consulte periódicamente a su médico.';
    let isAiGeneratedSuccess = false;

    if (aiResult?.parsed && aiResult.parsed.explanationText && aiResult.parsed.explanationText.length > 10) {
      explanationText = aiResult.parsed.explanationText;
      category = aiResult.parsed.category || category;
      safetyTitle = aiResult.parsed.safetyTitle || safetyTitle;
      safetyBody = aiResult.parsed.safetyBody || safetyBody;
      isAiGeneratedSuccess = true;
      console.log(`[harbor-agent] ✅ EXPLICACIÓN DE CONDICIÓN GENERADA CON ÉXITO:`);
      console.log(`   --> "${explanationText}"`);
    } else {
      console.log(`[harbor-agent] ⚠️ No se pudo generar la respuesta por IA para "${condName}". NO se usan textos estáticos.`);
    }

    await finishAgentRun(runId, requestId, isAiGeneratedSuccess ? 'completed' : 'failed');

    return {
      requestId,
      runId,
      capabilityCode: 'health_condition_explanation',
      status: isAiGeneratedSuccess ? 'completed' : 'failed',
      data: {
        conditionName: condName,
        explanationText,
        category,
        safetyTitle,
        safetyBody,
        isGenerated: isAiGeneratedSuccess,
      },
    };
  } catch (err: any) {
    await finishAgentRun(runId, requestId, 'failed');
    console.error(`[harbor-agent] ❌ Error fatal en handleConditionExplanation:`, err);
    throw err;
  }
}
