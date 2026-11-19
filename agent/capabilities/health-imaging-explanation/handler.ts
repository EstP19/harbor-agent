import { z } from 'zod';

const hashSchema = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/);
export const candidateSchema = z.object({
  id: z.string().trim().min(1).max(128),
  releaseId: z.string().min(1), status: z.enum(['approved', 'published']),
  languageCode: z.string().trim().min(2).max(5), lastVerified: z.string().trim().min(1),
  modality: z.string().trim().min(1).max(256), term: z.string().trim().min(1).max(256),
  aliases: z.array(z.string()).default([]), category: z.string().default(''),
  explanation: z.string().trim().min(1).max(24576), boundary: z.string().trim().min(1),
  framework: z.string().default(''), source: z.string().trim().min(1),
  verificationStatus: z.string().default(''), reviewer: z.string().trim().min(1),
  countriesText: z.string().default(''), authorizedCountries: z.array(z.string()).min(1),
  sourceSheet: z.string().trim().min(1), sourceRow: z.number().int().positive(), rowHash: hashSchema,
}).strict();

export const imagingExplanationRequestSchema = z.object({
  contractVersion: z.literal('health-imaging-explanation/v2'),
  releaseId: z.string().min(1),
  // A confirmed term/alias/ID, not prose to be interpreted by an AI.
  reportFinding: z.string().trim().min(1).max(4096), modality: z.string().trim().min(1).max(256),
  patientCountry: z.string().trim().length(2), patientLanguage: z.string().trim().min(2).max(5),
  candidates: z.array(candidateSchema).min(1).max(100),
}).strict();
export type HealthImagingExplanationRequest = z.infer<typeof imagingExplanationRequestSchema>;
export type HealthImagingCandidate = z.infer<typeof candidateSchema>;
// Retained only for source compatibility. Runtime never invokes a completion.
export type HealthImagingExplanationCompletion = (prompt: { systemPrompt: string; userPrompt: string }) => Promise<{ parsed: unknown; provider: 'gemini' | 'openai' } | null>;
export type HealthImagingExplanationHandlerResult =
  | { ok: true; data: HealthImagingCandidate & { clinicalSource: string }; provider: 'deterministic' }
  | { ok: false; code: 'HEALTH_IMAGING_EXPLANATION_REQUEST_REJECTED' | 'HEALTH_IMAGING_EXPLANATION_NO_MATCH' | 'HEALTH_IMAGING_EXPLANATION_AMBIGUOUS' | 'HEALTH_IMAGING_COUNTRY_UNAUTHORIZED' };

const key = (value: string) => value.normalize('NFC').trim().toLowerCase();

export async function handleHealthImagingExplanationRequest(payload: unknown, _dependencies: {
  completion?: HealthImagingExplanationCompletion;
} = {}): Promise<HealthImagingExplanationHandlerResult> {
  const parsed = imagingExplanationRequestSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, code: 'HEALTH_IMAGING_EXPLANATION_REQUEST_REJECTED' };
  const input = parsed.data;
  const country = input.patientCountry.toUpperCase();
  const allowed = input.candidates.filter(candidate => candidate.authorizedCountries.includes(country));
  if (!allowed.length) return { ok: false, code: 'HEALTH_IMAGING_COUNTRY_UNAUTHORIZED' };
  const matches = allowed.filter(candidate =>
    candidate.releaseId === input.releaseId && key(candidate.languageCode) === key(input.patientLanguage)
    && key(candidate.modality) === key(input.modality)
    && [candidate.id, candidate.term, ...candidate.aliases].some(alias => key(alias) === key(input.reportFinding)));
  if (!matches.length) return { ok: false, code: 'HEALTH_IMAGING_EXPLANATION_NO_MATCH' };
  if (matches.length !== 1) return { ok: false, code: 'HEALTH_IMAGING_EXPLANATION_AMBIGUOUS' };
  const candidate = matches[0];
  return { ok: true, data: { ...candidate, clinicalSource: candidate.source }, provider: 'deterministic' };
}
