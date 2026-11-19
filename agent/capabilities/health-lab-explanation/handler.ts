import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

const hashSchema = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/);
const blockSchema = z.object({
  a: z.string().trim().min(1).max(16_384).optional(),
  b: z.string().trim().min(1).max(16_384).optional(),
  c: z.string().trim().min(1).max(16_384).optional(),
}).strict();

const evidenceSchema = z.object({
  literalMarker: z.string().trim().min(1).max(256).nullable(),
  conceptCode: z.string().trim().min(1).max(256).nullable(),
  numericValue: z.string().trim().min(1).max(64).nullable(),
  unit: z.string().trim().min(1).max(128).nullable(),
  printedFlag: z.string().trim().min(1).max(32).nullable(),
  referenceRange: z.object({
    lowerBound: z.string().trim().min(1).max(64).nullable(),
    upperBound: z.string().trim().min(1).max(64).nullable(),
    unit: z.string().trim().min(1).max(128).nullable(),
  }).strict(),
}).strict();

const provenanceSchema = z.object({
  countryCode: z.enum(['NL','CO','MX','US','ES','AW','CW']), languageCode:z.enum(['nl','es','en','fr','pt','de','pap']).optional(), kbVersion: z.string().min(1).max(128),
  sourceSheet: z.string().min(1).max(256), sourceRow: z.number().int().positive(),
  fileHash: hashSchema, artifactSha256: hashSchema, sheetHash: hashSchema, rowHash: hashSchema,
  doctorName: z.string().min(1).max(256).optional(), doctorRegistration: z.string().min(1).max(64).optional(),
  reviewedDate: z.string().min(1).max(64).optional(),
}).strict();
const sectionSchema = z.object({
  label: z.string().min(1).max(256),
  stateCode: z.enum(['HIGH', 'NORMAL', 'LOW', 'POSITIVE', 'NEGATIVE', 'PROLONGED', 'SHORTENED', 'NO_BAND']),
  blocks: blockSchema, text: z.string().min(1).max(24576),
  guardrail: z.string().min(1).max(16384), sourcesText: z.string().min(1).max(16384),
  approvedBy: z.string().min(1).max(512), approvedAt: z.string().min(1).max(64),
  provenance: provenanceSchema,
}).strict();

const requestSchema = z.object({
  contractVersion: z.literal('health-lab-explanation/v1'),
  evidence: evidenceSchema,
  marker: z.string().trim().min(1).max(256),
  stateCode: z.enum(['HIGH', 'NORMAL', 'LOW', 'POSITIVE', 'NEGATIVE', 'PROLONGED', 'SHORTENED', 'NO_BAND']),
  level: z.enum(['L1', 'L2', 'L3']),
  blocks: z.object({ a: z.string().min(1).max(262144).optional(), b: z.string().min(1).max(262144).optional(), c: z.string().min(1).max(262144).optional() }).strict(),
  text: z.string().min(1).max(524288),
  guardrail: z.string().min(1).max(262144),
  sourcesText: z.string().min(1).max(262144),
  approvedBy: z.string().trim().min(1).max(512).optional(),
  approvedAt: z.string().trim().min(1).max(64).optional(),
  sourceType: z.literal('clinical_source').optional(),
  harborId: z.string().regex(/^HH_[A-Z0-9_]+$/).optional(),
  sections: z.array(sectionSchema).min(1).max(32).optional(),
  provenance: z.object({
    countryCode: z.enum(['NL','CO','MX','US','ES','AW','CW']), languageCode:z.enum(['nl','es','en','fr','pt','de','pap']).optional(),
    kbVersion: z.string().trim().min(1).max(128),
    sourceSheet: z.string().trim().min(1).max(256),
    sourceRow: z.number().int().positive(),
    fileHash: hashSchema,
    artifactSha256: hashSchema,
    sheetHash: hashSchema,
    rowHash: hashSchema,
    doctorName: z.string().trim().min(1).max(256).optional(),
    doctorRegistration: z.string().trim().min(1).max(64).optional(),
    reviewedDate: z.string().trim().min(1).max(64).optional(),
  }).strict(),
}).strict();

export type HealthLabExplanationRequest = z.infer<typeof requestSchema>;
type SealedHealthLabExplanation = Omit<HealthLabExplanationRequest, 'evidence'>;
export type HealthLabExplanationHandlerResult =
  | { ok: true; data: SealedHealthLabExplanation; provider: 'deterministic' }
  | { ok: false; code: 'HEALTH_LAB_EXPLANATION_REQUEST_REJECTED' | 'HEALTH_LAB_EXPLANATION_OUTPUT_REJECTED' };

function expectedText(input: HealthLabExplanationRequest): string | null {
  if(input.sourceType==='clinical_source'){const key=input.level==='L1'?'a':input.level==='L2'?'b':'c';return Object.keys(input.blocks).length===1?input.blocks[key]??null:null;}
  if(!input.blocks.a)return null;
  if (input.level === 'L1' && !input.blocks.b && !input.blocks.c) return input.blocks.a;
  if (input.level === 'L2' && input.blocks.b && !input.blocks.c) return `${input.blocks.a}\n\n${input.blocks.b}`;
  if (input.level === 'L3' && input.blocks.b && input.blocks.c) return `${input.blocks.a}\n\n${input.blocks.b}\n\n${input.blocks.c}`;
  return null;
}

export async function handleHealthLabExplanationRequest(
  input: unknown,
): Promise<HealthLabExplanationHandlerResult> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'HEALTH_LAB_EXPLANATION_REQUEST_REJECTED' };

  const value = parsed.data;
  if(value.provenance.countryCode!=='NL'&&!value.provenance.languageCode)return {ok:false,code:'HEALTH_LAB_EXPLANATION_REQUEST_REJECTED'};
  const bundle = Boolean(value.sections);
  const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');
  if (Object.values(value.blocks).some(text => typeof text !== 'string' || byteLength(text) > (bundle ? 262144 : 16384))
    || byteLength(value.text) > (bundle ? 524288 : 24576)
    || [value.guardrail, value.sourcesText].some(text => byteLength(text) > (bundle ? 262144 : 16384))
    || byteLength(JSON.stringify(value)) > (bundle ? 1048576 : 65536)) {
    return { ok: false, code: 'HEALTH_LAB_EXPLANATION_REQUEST_REJECTED' };
  }
  const approvalValues = [
    value.approvedBy,
    value.approvedAt,
    value.provenance.doctorName,
    value.provenance.doctorRegistration,
    value.provenance.reviewedDate,
  ];
  const hasApproval = approvalValues.some(item => item !== undefined);
  const approvalMatches = !hasApproval || (
    approvalValues.every(item => item !== undefined)
    && value.approvedBy === `${value.provenance.doctorName} (${value.provenance.doctorRegistration})`
    && value.approvedAt === value.provenance.reviewedDate
  );
  if (value.provenance.fileHash !== value.provenance.artifactSha256
    || expectedText(value) !== value.text
    || !approvalMatches) {
    return { ok: false, code: 'HEALTH_LAB_EXPLANATION_OUTPUT_REJECTED' };
  }

  if (value.sourceType || value.harborId || value.sections) {
    const sections = value.sections;
    if (!sections || !value.harborId || value.sourceType !== 'clinical_source' || sections.length!==1
      || new Set(sections.map(section => section.label)).size !== sections.length) {
      return { ok: false, code: 'HEALTH_LAB_EXPLANATION_OUTPUT_REJECTED' };
    }
    for (const section of sections) {
      if (section.provenance.countryCode!==value.provenance.countryCode || (section.provenance.languageCode??'nl')!==(value.provenance.languageCode??'nl') || section.stateCode!==value.stateCode || expectedText({ ...value, blocks: section.blocks }) !== section.text
        || section.provenance.fileHash !== value.provenance.fileHash
        || section.provenance.artifactSha256 !== value.provenance.artifactSha256
        || section.provenance.sourceSheet !== value.provenance.sourceSheet
        || section.provenance.sheetHash !== value.provenance.sheetHash
        || section.provenance.kbVersion !== value.provenance.kbVersion
        || section.approvedBy !== `${section.provenance.doctorName} (${section.provenance.doctorRegistration})`
        || section.approvedAt !== section.provenance.reviewedDate) {
        return { ok: false, code: 'HEALTH_LAB_EXPLANATION_OUTPUT_REJECTED' };
      }
    }
    const join = (key: 'a' | 'b' | 'c') => sections.map(section => `## ${section.label}\n\n${section.blocks[key]}`).join('\n\n');
    const key=value.level==='L1'?'a':value.level==='L2'?'b':'c';
    if (value.blocks[key] !== join(key)
      || value.guardrail !== [...new Set(sections.map(section => section.guardrail))].join('\n\n')
      || value.sourcesText !== [...new Set(sections.map(section => section.sourcesText))].join('\n\n')
      || !isDeepStrictEqual(value.provenance, sections[0].provenance)
      || value.approvedBy !== sections[0].approvedBy || value.approvedAt !== sections[0].approvedAt) {
      return { ok: false, code: 'HEALTH_LAB_EXPLANATION_OUTPUT_REJECTED' };
    }
  }

  const { evidence: _evidence, ...sealed } = value;
  return { ok: true, data: sealed, provider: 'deterministic' };
}
