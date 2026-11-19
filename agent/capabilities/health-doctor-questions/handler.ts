import { createDoctorQuestionsRequestHash, type DoctorQuestionsReservation } from './reservation.ts';
import { doctorQuestionsCapsuleSchema, doctorQuestionsOutputSchema, type DoctorQuestionsOutput } from './schema.ts';
import { doctorQuestionGrammar, validateDoctorQuestionsOutput } from './validator.ts';

export type DoctorQuestionsHandlerResult =
  | { ok: true; output: DoctorQuestionsOutput }
  | { ok: false; code: 'DOCTOR_QUESTIONS_REQUEST_REJECTED' | 'DOCTOR_QUESTIONS_DUPLICATE' | 'DOCTOR_QUESTIONS_CONFLICT' | 'DOCTOR_QUESTIONS_TEMPORARY_FAILURE' | 'DOCTOR_QUESTIONS_OUTPUT_REJECTED' };

async function abortable<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createDoctorQuestionsHandler(dependencies: {
  reservation: DoctorQuestionsReservation;
  completion: (prompt: { systemPrompt: string; userPrompt: string }, signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
  finalizeTimeoutMs?: number;
}) {
  return async (input: unknown): Promise<DoctorQuestionsHandlerResult> => {
    const parsed = doctorQuestionsCapsuleSchema.safeParse(input);
    if (!parsed.success) {
      console.warn('[health-doctor-questions] Schema parsing failed:', parsed.error);
      return { ok: false, code: 'DOCTOR_QUESTIONS_REQUEST_REJECTED' };
    }
    const capsule = parsed.data;
    const requestHash = createDoctorQuestionsRequestHash(capsule);
    let claim;
    try { claim = await dependencies.reservation.claim({ idempotencyKey: capsule.requestKey, requestHash }); }
    catch { return { ok: false, code: 'DOCTOR_QUESTIONS_TEMPORARY_FAILURE' }; }
    if (claim.kind === 'conflict') return { ok: false, code: 'DOCTOR_QUESTIONS_CONFLICT' };
    if (claim.kind === 'duplicate' && claim.status === 'running') return { ok: false, code: 'DOCTOR_QUESTIONS_DUPLICATE' };
    if (claim.kind === 'duplicate') {
      const replay = doctorQuestionsOutputSchema.safeParse(claim.output);
      return replay.success && validateDoctorQuestionsOutput(capsule, replay.data).ok
        ? { ok: true, output: replay.data }
        : { ok: false, code: 'DOCTOR_QUESTIONS_OUTPUT_REJECTED' };
    }

    const openerByLang: Record<string, string> = {
      es: '¿Qué, ¿Cuál, ¿Cuáles, ¿Cómo, ¿Por qué, ¿Puede, ¿Pueden, ¿Tiene, ¿Tienen, ¿Qué tan, o ¿En qué (empezando con ¿ y terminando con ?)',
      en: 'What, Which, How, Why, Can, Could, Does, Do, Is, or Are (ending with ?)',
      nl: 'Wat, Welke, Hoe, Waarom, Kan, Kunnen, Heeft, Is, or Zijn (ending with ?)',
      fr: "Qu’est-ce que, Quel, Quelle, Quels, Quelles, Comment, Pourquoi, Que ou Peut (terminer par ?)",
      de: 'Was, Welche, Welcher, Welches, Wie, Warum, Kann, Können, Ist oder Sind (mit ? beenden)',
      pt: 'O que, Qual, Quais, Como, Por que, Pode ou Podem (terminar com ?)',
      pap: 'Kiko, Kon, Pakon, Kua, Kuanto, Por òf Ki (terminá ku ?)',
    };
    const opener = openerByLang[capsule.languageCode] ?? openerByLang['es'];

    const topicLines = capsule.topics.map(topic =>
      `Motivo/Tema: "${topic.approvedName}"\nContexto: ${topic.generalTopic}`
    ).join('\n\n');

    const systemPrompt = [
      `Redacta exactamente ${capsule.targetQuantity} preguntas educativas generales para conversar con un médico sobre los temas aprobados proporcionados.`,
      `Idioma: ${capsule.languageCode}.`,
      `REGLAS OBLIGATORIAS:`,
      `1. Cada pregunta DEBE empezar con una palabra interrogativa: ${opener}.`,
      `2. Cada pregunta debe incluir el nombre aprobado completo de uno de los temas, sin abreviarlo. Usa únicamente palabras de ese tema y estas palabras gramaticales: ${doctorQuestionGrammar(capsule.languageCode).join(', ')}.`,
      `3. No añadas hábitos, prevención, consejos, datos personales ni hechos clínicos ajenos al texto. No uses pronombres personales. No afirmes ni sugieras diagnósticos, tratamientos, dosis, urgencias o riesgos. Si un nombre aprobado contiene un término clínico, solo puedes repetirlo dentro de ese nombre.`,
      `4. Devuelve ÚNICAMENTE un objeto JSON válido con la clave "questions": {"questions": ["¿...?", "¿...?", ...]}`,
    ].join('\n');

    const userPrompt = topicLines;
    let raw: unknown;
    const providerTimeoutMs = Math.min(dependencies.timeoutMs ?? 60_000, 60_000);
    const finalizeTimeoutMs = Math.min(dependencies.finalizeTimeoutMs ?? 5_000, 5_000);
    const finalize = (status: 'completed' | 'failed' | 'rejected', output?: DoctorQuestionsOutput) => abortable(
      signal => dependencies.reservation.finalize({ idempotencyKey: capsule.requestKey, requestHash, claimToken: claim.claimToken, status, output }, signal),
      finalizeTimeoutMs,
    );

    try {
      raw = await abortable(async signal => {
        let candidate: unknown;
        const acceptedQuestions = new Map<string, string>();
        for (let attempt = 0; attempt < 2; attempt += 1) {
          candidate = await dependencies.completion({ systemPrompt, userPrompt: attempt === 0 ? userPrompt : [
            userPrompt,
            'La respuesta anterior no cumplió la validación. Reescribe las preguntas usando SOLAMENTE el nombre aprobado completo y las palabras gramaticales permitidas. No añadas ninguna otra palabra ni concepto. Comprueba cada palabra antes de responder.',
          ].join('\n\n') }, signal);
          const parsedCandidate = doctorQuestionsOutputSchema.safeParse(candidate);
          if (parsedCandidate.success && validateDoctorQuestionsOutput(capsule, parsedCandidate.data).ok) return parsedCandidate.data;
          if (parsedCandidate.success) {
            for (const question of parsedCandidate.data.questions) {
              if (validateDoctorQuestionsOutput({ ...capsule, targetQuantity: 1 }, { questions: [question] }).ok) {
                acceptedQuestions.set(question.toLocaleLowerCase(), question);
              }
            }
            if (acceptedQuestions.size >= capsule.targetQuantity) {
              return { questions: [...acceptedQuestions.values()].slice(0, capsule.targetQuantity) };
            }
          }
        }
        return candidate;
      }, providerTimeoutMs);
    } catch (e: any) {
      console.warn('[health-doctor-questions] Completion failed:', e?.message || e);
      try { await finalize('failed'); } catch {}
      return { ok: false, code: 'DOCTOR_QUESTIONS_TEMPORARY_FAILURE' };
    }

    const output = doctorQuestionsOutputSchema.safeParse(raw);
    const validation = output.success ? validateDoctorQuestionsOutput(capsule, output.data) : null;
    if (!output.success || !validation?.ok) {
      console.warn('[health-doctor-questions] Output rejected — zod success:', output.success, '| validation:', validation, '| raw:', JSON.stringify(raw));
      try { await finalize('rejected'); } catch {}
      return { ok: false, code: 'DOCTOR_QUESTIONS_OUTPUT_REJECTED' };
    }

    try { await finalize('completed', output.data); }
    catch { return { ok: false, code: 'DOCTOR_QUESTIONS_TEMPORARY_FAILURE' }; }
    return { ok: true, output: output.data };
  };
}
