import { generateAiJsonResponse } from '../../../lib/ai-provider.ts';
import {
  consultationReviewCapsuleSchema,
  consultationReviewOutputSchema,
  type ConsultationReviewCapsule,
  type ConsultationReviewOutput,
} from './schema.ts';
import { buildConsultationReviewPrompt } from './prompt.ts';

export async function handleConsultationReviewRequest(rawPayload: unknown): Promise<{
  ok: true;
  data: ConsultationReviewOutput;
} | {
  ok: false;
  code: string;
  error?: string;
}> {
  const parsed = consultationReviewCapsuleSchema.safeParse(rawPayload);
  if (!parsed.success) {
    console.warn('[health-consultation-review] ⚠️ Invalid input payload:', parsed.error.format());
    return { ok: false, code: 'INVALID_CAPSULE_PAYLOAD', error: parsed.error.message };
  }

  const capsule = parsed.data;
  console.log(`[health-consultation-review] 📋 Generando preparación de consulta para motivo: "${capsule.visitReason}" con ${capsule.attachedItems.length} elementos adjuntos (${capsule.languageCode})...`);

  try {
    const { systemPrompt, userPrompt } = buildConsultationReviewPrompt(capsule);
    const aiResult = await generateAiJsonResponse({
      systemPrompt,
      userPrompt,
      temperature: 0.3,
    });

    const candidate = aiResult?.parsed;
    if (!candidate || typeof candidate !== 'object') {
      console.warn('[health-consultation-review] ⚠️ AI did not return a valid JSON object.');
      throw new Error('AI completion unavailable');
    }

    const getFallbackQuestions = () => {
      const reason = capsule.visitReason;
      if (reason === 'checkup') {
        return [
          { id: 'q_1', question: '¿Cuáles son las metas de salud preventiva prioritarias para mi edad y estado general?', rationale: 'Permite establecer prioridades en el chequeo de rutina.', priority: 'high' as const, category: 'Prevención' },
          { id: 'q_2', question: '¿Qué estudios de tamizaje o exámenes rutinarios corresponden para mi grupo de edad?', rationale: 'Identifica evaluaciones de prevención oportunas.', priority: 'high' as const, category: 'Tamizaje' },
          { id: 'q_3', question: '¿Hay hábitos de alimentación, sueño o actividad física que deba ajustar este año?', rationale: 'Promueve medidas de salud preventivas activas.', priority: 'medium' as const, category: 'Estilo de vida' },
        ];
      }
      if (reason === 'complaint') {
        return [
          { id: 'q_1', question: '¿Cuál considera que es la causa más probable de mi síntoma o molestia actual?', rationale: 'Orientación diagnóstica inicial sobre la causa del síntoma.', priority: 'high' as const, category: 'Diagnóstico' },
          { id: 'q_2', question: '¿Qué signos de alarma o cambios en el síntoma debo vigilar para acudir a urgencias?', rationale: 'Monitoreo de seguridad y evolución del síntoma.', priority: 'high' as const, category: 'Seguridad' },
          { id: 'q_3', question: '¿Se requiere alguna prueba de laboratorio o imagenología para evaluar este síntoma?', rationale: 'Definición del plan de evaluación diagnóstica.', priority: 'medium' as const, category: 'Evaluación' },
        ];
      }
      if (reason === 'referral') {
        return [
          { id: 'q_1', question: '¿Cuál es el objetivo principal y la expectativa de la valoración por el especialista?', rationale: 'Define la meta de la consulta especializada.', priority: 'high' as const, category: 'Especialidad' },
          { id: 'q_2', question: '¿Qué antecedentes y estudios previos debo llevar preparados a la cita especializada?', rationale: 'Garantiza la continuidad de la información clínica.', priority: 'high' as const, category: 'Antecedentes' },
          { id: 'q_3', question: '¿Cómo coordinaremos el seguimiento posterior entre el especialista y el médico tratante?', rationale: 'Favorece un plan de cuidado integrado.', priority: 'medium' as const, category: 'Seguimiento' },
        ];
      }
      if (reason === 'medreview') {
        return [
          { id: 'q_1', question: '¿Mis medicamentos y suplementos actuales siguen siendo adecuados y seguros?', rationale: 'Conciliación y revisión periódica del tratamiento farmacológico.', priority: 'high' as const, category: 'Tratamiento' },
          { id: 'q_2', question: '¿Existe alguna interacción o efecto secundario relevante a vigilar entre lo que tomo?', rationale: 'Prevención de eventos adversos medicamentosos.', priority: 'high' as const, category: 'Seguridad' },
          { id: 'q_3', question: '¿Hay algún fármaco o dosis que sea conveniente ajustar, simplificar o suspender?', rationale: 'Optimización de la terapia médica activa.', priority: 'medium' as const, category: 'Ajuste' },
        ];
      }
      return [
        { id: 'q_1', question: '¿Cómo se comparan estos resultados recientes con mi estado de salud basal?', rationale: 'Permite comprender la evolución general.', priority: 'high' as const, category: 'Evolución' },
        { id: 'q_2', question: '¿Hay recomendaciones de estilo de vida o seguimiento específicas a seguir?', rationale: 'Favorece medidas preventivas activas.', priority: 'high' as const, category: 'Estilo de vida' },
        { id: 'q_3', question: '¿Cuándo sería oportuno realizar un próximo control de seguimiento?', rationale: 'Asegura la continuidad del cuidado médico.', priority: 'medium' as const, category: 'Prevención' },
      ];
    };

    // Adaptar y validar estructura devuelta
    const adaptedOutput: ConsultationReviewOutput = {
      contractVersion: 'health-consultation-review/v1',
      languageCode: capsule.languageCode,
      summary: candidate.summary || `Guía estructurada para la consulta médica sobre ${capsule.visitReasonLabel || capsule.visitReason}.`,
      questions: Array.isArray(candidate.questions) && candidate.questions.length > 0
        ? candidate.questions.map((q: any, i: number) => ({
            id: q.id || `q_${i + 1}`,
            question: q.question || '¿Cuál es el plan de seguimiento recomendado?',
            rationale: q.rationale || 'Ayuda a planificar el cuidado preventivo y la evolución.',
            priority: ['high', 'medium', 'low'].includes(q.priority) ? q.priority : 'high',
            category: q.category || 'General',
          }))
        : getFallbackQuestions(),
      keyDiscussionPoints: Array.isArray(candidate.keyDiscussionPoints) && candidate.keyDiscussionPoints.length > 0
        ? candidate.keyDiscussionPoints
        : [
            `Abordar en detalle las dudas sobre ${capsule.visitReasonLabel || capsule.visitReason}.`,
            'Establecer un plan claro de seguimiento y próximos pasos con el médico.',
          ],
      preparationChecklist: Array.isArray(candidate.preparationChecklist) && candidate.preparationChecklist.length > 0
        ? candidate.preparationChecklist
        : [
            'Anotar antecedentes relevantes y lista de preguntas ordenadas.',
            'Llevar documentos de soporte, medicamentos o notas previas a la cita.',
          ],
    };

    console.log(`[health-consultation-review] ✅ ${adaptedOutput.questions.length} preguntas clínicas generadas exitosamente.`);
    return { ok: true, data: adaptedOutput };
  } catch (err: any) {
    console.error('[health-consultation-review] 💥 Error en generación:', err?.message || err);
    return { ok: false, code: 'CONSULTATION_REVIEW_GENERATION_FAILED', error: err?.message || 'internal error' };
  }
}
