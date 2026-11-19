import type { DetailedExplanationCapsule } from './schema.ts';

const levelDescriptions = {
  L1: 'Nivel 1 (Paciente / Básico): Explicación clara, directa y comprensible para cualquier persona, sin tecnicismos excesivos, educativa y tranquilizadora.',
  L2: 'Nivel 2 (Intermedio / Clínico): Explicación con detalle de vías metabólicas, función celular y significado de las variaciones del parámetro.',
  L3: 'Nivel 3 (Especializado / Avanzado): Explicación profunda y exhaustiva con mecanismos fisiopatológicos, consideraciones analíticas y evidencia clínica.',
} as const;

export function buildDetailedExplanationPrompt(capsule: DetailedExplanationCapsule) {
  const langName = capsule.languageCode === 'en' ? 'Inglés (English)' : capsule.languageCode === 'nl' ? 'Holandés (Nederlands)' : 'Español';
  const levelGuide = levelDescriptions[capsule.level] ?? levelDescriptions.L1;

  const systemPrompt = [
    `Eres un médico y educador en salud experto.`,
    `Tu tarea es generar una explicación médica completa, rigurosa, clara y estructurada para el biomarcador o concepto clínico "${capsule.displayName || capsule.conceptCode}".`,
    ``,
    `DIRECTRICES FUNDAMENTALES:`,
    `1. Idioma obligatorio: Todo el texto debe estar escrito EXCLUSIVAMENTE en ${langName}.`,
    `2. Nivel de profundidad: ${levelGuide}`,
    `3. Tono: Educativo, profesional, comprensible y preventivo. Evita alarmismos y diagnósticos categóricos sin contexto clínico.`,
    `Use only approvedContentBlocks as evidence. Copy each selected approved-content sentence in full; do not extract a clause or combine fragments. Preserve negation, modality, conditionals, or attribution and terminal question/exclamation punctuation.`,
    `Do not add personal interpretations, diagnostic assertions, treatment, risk, or urgency advice. Keep unsupported array sections empty. Use only supplied source references; L1 must have an empty sourceRefs array.`,
    `Total prose word budget: L1 120–180, L2 220–320, L3 320–480. Return only complete grounded content within the selected level's budget.`,
    `4. Reglas de redacción médica:`,
    `   - Redacta de forma impersonal y objetiva sobre el biomarcador (ej. "Este parámetro refleja...", "Su función principal es...").`,
    `   - NO afirmes diagnósticos personales ni uses frases prescriptivas como "tu resultado muestra", "usted padece", "debes tomar medicamentos" o "acude de urgencia".`,
    `5. Formato de salida: Devuelve ÚNICAMENTE un objeto JSON válido (sin etiquetas markdown ni texto adicional) con EXACTAMENTE estas claves:`,
    `   - contractVersion: "${capsule.contractVersion}"`,
    `   - outputSchemaVersion: "${capsule.outputSchemaVersion}"`,
    `   - capabilityVersion: "health-detailed-explanation-capability/v1"`,
    `   - conceptCode: "${capsule.conceptCode}"`,
    `   - languageCode: "${capsule.languageCode}"`,
    `   - level: "${capsule.level}"`,
    `   - summary: Resumen conciso y claro de qué es este parámetro y su relevancia en la salud general.`,
    `   - biologicalRole: Función biológica y fisiológica que cumple en el cuerpo humano.`,
    `   - whyMeasured: Por qué los profesionales de salud solicitan esta prueba y qué aspectos evalúa.`,
    `   - generalConsiderations: Array de 2 a 4 oraciones con consideraciones de estilo de vida, hábitos y bienestar general relacionados.`,
    `   - measurementNotes: Array de 2 a 3 oraciones sobre la interpretación habitual, rangos y preparación para la prueba.`,
    `   - limitations: Array de 2 a 3 oraciones sobre limitaciones analíticas, variaciones fisiológicas o factores temporales que pueden influir.`,
    `   - sourceRefs: Array vacío [] (a menos que se hayan provisto referencias específicas).`,
  ].join('\n');

  const userPrompt = JSON.stringify({
    conceptCode: capsule.conceptCode,
    displayName: capsule.displayName,
    languageCode: capsule.languageCode,
    level: capsule.level,
    approvedContentBlocks: capsule.approvedContentBlocks,
    approvedSources: capsule.approvedSources,
  });

  return { systemPrompt, userPrompt };
}
