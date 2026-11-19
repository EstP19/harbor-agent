import { z } from 'zod';

const topicSchema = z.object({
  conceptCode: z.string().trim().min(1).max(200),
  approvedName: z.string().trim().min(1).max(500),
  generalTopic: z.string().trim().min(1).max(8_000),
}).strict();

export const doctorQuestionsCapsuleSchema = z.object({
  contractVersion: z.literal('health-doctor-questions/v2'),
  requestKey: z.string().regex(/^[a-f0-9]{64}$/),
  languageCode: z.enum(['es', 'en', 'nl', 'fr', 'de', 'pt', 'pap']),
  level: z.enum(['L1', 'L2', 'L3']),
  targetQuantity: z.number().int().min(3).max(7),
  topics: z.array(topicSchema).min(1).max(20),
}).strict();

export const doctorQuestionsOutputSchema = z.object({
  questions: z.array(z.string().trim().min(2).max(1_000)).min(3).max(7),
}).strict();

export type DoctorQuestionsCapsule = z.infer<typeof doctorQuestionsCapsuleSchema>;
export type DoctorQuestionsOutput = z.infer<typeof doctorQuestionsOutputSchema>;

// The provider enforces the envelope; the existing validator still enforces grounding and clinical safety.
export const doctorQuestionsJsonSchema = {
  name:'harbor_doctor_questions',
  schema:{type:'object',properties:{questions:{type:'array',items:{type:'string'},minItems:3,maxItems:7}},
    required:['questions'],additionalProperties:false},
};
