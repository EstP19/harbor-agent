import { z } from 'zod';

export const consultationReviewItemSchema = z.object({
  id: z.string(),
  type: z.enum(['lab', 'radiology', 'wearable', 'functions', 'apple_health', 'analysis']),
  name: z.string(),
  summary: z.string(),
  dateStr: z.string().optional(),
});

export const consultationReviewCapsuleSchema = z.object({
  contractVersion: z.literal('health-consultation-review/v1'),
  languageCode: z.enum(['es', 'en', 'nl']),
  visitReason: z.string().min(1),
  visitReasonLabel: z.string().optional(),
  additionalContext: z.string().optional(),
  targetQuantity: z.number().int().min(1).max(10).default(5),
  attachedItems: z.array(consultationReviewItemSchema).default([]),
});

export type ConsultationReviewCapsule = z.infer<typeof consultationReviewCapsuleSchema>;
export type ConsultationReviewItem = z.infer<typeof consultationReviewItemSchema>;

export const generatedConsultationQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  rationale: z.string(),
  priority: z.enum(['high', 'medium', 'low']).default('high'),
  category: z.string().optional(),
});

export const consultationReviewOutputSchema = z.object({
  contractVersion: z.literal('health-consultation-review/v1'),
  languageCode: z.enum(['es', 'en', 'nl']),
  summary: z.string(),
  questions: z.array(generatedConsultationQuestionSchema),
  keyDiscussionPoints: z.array(z.string()),
  preparationChecklist: z.array(z.string()),
});

export type ConsultationReviewOutput = z.infer<typeof consultationReviewOutputSchema>;
