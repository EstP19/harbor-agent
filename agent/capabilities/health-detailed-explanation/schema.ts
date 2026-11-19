import { z } from 'zod';

const opaqueIdentifierSchema = z.string().min(1).max(200);
const languageCodeSchema = z.enum(['es', 'en', 'nl']);
const detailedExplanationLevelSchema = z.enum(['L1', 'L2', 'L3']);

const approvedContentBlockSchema = z.object({
  contentBlockId: opaqueIdentifierSchema,
  contentVersionId: opaqueIdentifierSchema,
  contentHash: z.string().min(1).max(256),
  text: z.string().min(1).max(40_000),
}).strict();

const approvedSourceSchema = z.object({
  sourceRef: opaqueIdentifierSchema,
  sourceVersionId: opaqueIdentifierSchema,
  sourceContentHash: z.string().min(1).max(256),
}).strict();

export const detailedExplanationCapsuleSchema = z.object({
  contractVersion: z.literal('health-detailed-explanation/v1'),
  outputSchemaVersion: z.literal('health-detailed-explanation-output/v1'),
  idempotencyKey: opaqueIdentifierSchema,
  requestId: opaqueIdentifierSchema,
  itemId: opaqueIdentifierSchema,
  conceptCode: z.string().min(1).max(200),
  displayName: z.string().min(1).max(500),
  languageCode: languageCodeSchema,
  level: detailedExplanationLevelSchema,
  approvedContentBlocks: z.array(approvedContentBlockSchema).min(1).max(100),
  approvedSources: z.array(approvedSourceSchema).max(100),
}).strict();

export const detailedExplanationOutputSchema = z.object({
  contractVersion: z.literal('health-detailed-explanation/v1'),
  outputSchemaVersion: z.literal('health-detailed-explanation-output/v1'),
  capabilityVersion: z.literal('health-detailed-explanation-capability/v1'),
  conceptCode: z.string().min(1).max(200),
  languageCode: languageCodeSchema,
  level: detailedExplanationLevelSchema,
  summary: z.string().trim().min(1).max(8_000),
  biologicalRole: z.string().trim().min(1).max(8_000),
  whyMeasured: z.string().trim().min(1).max(8_000),
  generalConsiderations: z.array(z.string().min(1).max(8_000)).max(30),
  measurementNotes: z.array(z.string().min(1).max(8_000)).max(30),
  limitations: z.array(z.string().min(1).max(8_000)).max(30),
  sourceRefs: z.array(opaqueIdentifierSchema).max(100),
}).strict();

export type DetailedExplanationCapsule = z.infer<typeof detailedExplanationCapsuleSchema>;
export type DetailedExplanationOutput = z.infer<typeof detailedExplanationOutputSchema>;
