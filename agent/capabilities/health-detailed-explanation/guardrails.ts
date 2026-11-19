import {
  detailedExplanationCapsuleSchema,
  detailedExplanationOutputSchema,
  type DetailedExplanationCapsule,
  type DetailedExplanationOutput,
} from './schema.ts';

const wordBudgets = {
  L1: { minimum: 120, maximum: 180 },
  L2: { minimum: 220, maximum: 320 },
  L3: { minimum: 320, maximum: 480 },
} as const;

const prohibitedPatterns = [
  /(?:^|[^\p{L}\p{N}])(your|tu|tus|su|sus|jouw|je|uw)[\s,;:—–-]+(result|value|level|case|situation|risk|resultado|valor|nivel|caso|situacion|riesgo|resultaat|waarde|niveau|geval|situatie|risico)(?=$|[^\p{L}\p{N}])/u,
  /(?:^|[^\p{L}\p{N}])diagnos\p{L}*(?=$|[^\p{L}\p{N}])/u,
  /\b(treatment|treat|medication|medicine|tratamiento|tratar|medicacion|medicamento|behandeling|behandelen|medicatie|geneesmiddel)\b/u,
  /\b(dose|dosis)\b/u,
  /\b(you\s+should|see\s+(a|your)\s+doctor|take\s+\p{L}+|(?:acude|acuda)\s+al\s+medico|(?:debes|deberias)\s+(?:consultar|acudir)|consultar\s+a\s+un\s+medico|toma\s+\p{L}+|u\s+moet|raadpleeg\s+een\s+arts|neem\s+\p{L}+)\b/u,
  /\b(urgent|urgently|emergency|immediately|urgente|urgentemente|emergencia|inmediatamente|spoed|onmiddellijk)\b/u,
  /\b(confirma|demuestra|prueba|indica|confirms|demonstrates|proves|shows|bevestigt|bewijst)\b/u,
  /\btoont\b[^.!?;\n]*\baan\b/u,
  /\b(?:es\s+prueba\s+de|es\s+compatible\s+con|is\s+proof\s+of|is\s+consistent\s+with|is\s+bewijs\s+van|past\s+bij)\b/u,
  /\b(?:es\s+diagnostico\s+de|is\s+diagnostic\s+of|is\s+diagnostisch\s+voor)\b/u,
];

const genericResultAnchor = /(?:^|[^\p{L}\p{N}])(?:marker|result|value|level|marcador|resultado|valor|nivel|marker|resultaat|waarde|niveau)(?=$|[^\p{L}\p{N}])/u;
const abnormalState = /(?:^|[^\p{L}\p{N}])(?:high|low|elevated|decreased|increased|abnormal|raised|reduced|above\s+normal|below\s+normal|outside\s+(?:the\s+)?range|alto|alta|altos|altas|bajo|baja|bajos|bajas|elevado|elevada|elevados|elevadas|disminuido|disminuida|disminuidos|disminuidas|reducido|reducida|reducidos|reducidas|aumentado|aumentada|aumentados|aumentadas|incrementado|incrementada|incrementados|incrementadas|anormal|anormales|por\s+encima|por\s+debajo|fuera\s+de\s+rango|hoog|hoge|laag|lage|verhoogd|verlaagde|verlaagd|gestegen|gedaald|toegenomen|afgenomen|verminderd|verminderde|abnormaal|afwijkend|afwijkende|buiten\s+(?:het\s+)?bereik)(?=$|[^\p{L}\p{N}])/u;
const anaphoricAssertion = /^(?:this|that|it|this\s+(?:finding|marker|result)|the\s+finding|esto|eso|ello|este|esta|este\s+(?:hallazgo|marcador|resultado)|el\s+hallazgo|dit|dat|het|deze|dit\s+(?:resultaat|teken)|de\s+bevinding)(?=$|[^\p{L}\p{N}])/u;

export type DetailedExplanationValidationResult =
  | { ok: true; value: DetailedExplanationOutput }
  | { ok: false; code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' };

function rejected(): DetailedExplanationValidationResult {
  return { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' };
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');
}

function proseFields(output: DetailedExplanationOutput): string[] {
  return [
    output.summary,
    output.biologicalRole,
    output.whyMeasured,
    ...output.generalConsiderations,
    ...output.measurementNotes,
    ...output.limitations,
  ];
}

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function conceptAnchors(capsule: DetailedExplanationCapsule): RegExp[] {
  const names = [capsule.displayName, capsule.conceptCode]
    .map(normalize)
    .flatMap(value => [value, ...(value.match(/[\p{L}\p{N}]+/gu) ?? [])])
    .filter(value => value.length >= 3);
  return [...new Set(names)].map(value => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(value)}(?=$|[^\\p{L}\\p{N}])`, 'u'));
}

function assertsMarkerState(capsule: DetailedExplanationCapsule, output: DetailedExplanationOutput): boolean {
  const anchors = conceptAnchors(capsule);
  const sentences = proseFields(output).flatMap(field => normalize(field).split(/[.!?;\n]+/u)).map(sentence => sentence.trim()).filter(Boolean);
  const hasMarkerAnchor = (sentence: string) => genericResultAnchor.test(sentence) || anchors.some(anchor => anchor.test(sentence));
  return sentences.some((sentence, index) => abnormalState.test(sentence)
    && (hasMarkerAnchor(sentence) || (index > 0 && anaphoricAssertion.test(sentence) && hasMarkerAnchor(sentences[index - 1]))));
}

function tokens(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalizedSentenceKeys(text: string): string[] {
  return (normalize(text).match(/[^.!?\n]+(?:[.!?]+|(?=\n|$))/gu) ?? [])
    .map(sentence => {
      const content = tokens(sentence).join(' ');
      const terminal = sentence.trimEnd().match(/[.!?]+$/u)?.[0] ?? '';
      const modality = terminal.includes('?') ? '?' : terminal.includes('!') ? '!' : '.';
      return content ? `${modality} ${content}` : '';
    })
    .filter(Boolean);
}

function hasFullSentenceGrounding(capsule: DetailedExplanationCapsule, output: DetailedExplanationOutput): boolean {
  const approvedSentences = new Set(capsule.approvedContentBlocks.flatMap(block => normalizedSentenceKeys(block.text)));
  return proseFields(output).every(field => {
    const generatedSentences = normalizedSentenceKeys(field);
    return generatedSentences.length > 0 && generatedSentences.every(sentence => approvedSentences.has(sentence));
  });
}

function violatesMedicalBoundary(capsule: DetailedExplanationCapsule, output: DetailedExplanationOutput): boolean {
  const prose = normalize(proseFields(output).join(' '));
  return prohibitedPatterns.some(pattern => pattern.test(prose)) || assertsMarkerState(capsule, output);
}

function hasExactIdentity(capsule: DetailedExplanationCapsule, output: DetailedExplanationOutput): boolean {
  return output.contractVersion === capsule.contractVersion
    && output.outputSchemaVersion === capsule.outputSchemaVersion
    && output.conceptCode === capsule.conceptCode
    && output.languageCode === capsule.languageCode
    && output.level === capsule.level;
}

function hasAllowedSources(capsule: DetailedExplanationCapsule, output: DetailedExplanationOutput): boolean {
  if (capsule.level === 'L1' && output.sourceRefs.length > 0) return false;
  const suppliedSourceRefs = new Set(capsule.approvedSources.map(source => source.sourceRef));
  return output.sourceRefs.every(sourceRef => suppliedSourceRefs.has(sourceRef));
}

export function validateDetailedExplanationOutput(
  capsuleInput: unknown,
  outputInput: unknown,
): DetailedExplanationValidationResult {
  const capsuleResult = detailedExplanationCapsuleSchema.safeParse(capsuleInput);
  const outputResult = detailedExplanationOutputSchema.safeParse(outputInput);
  if (!capsuleResult.success || !outputResult.success) return rejected();

  const capsule = capsuleResult.data;
  const output = outputResult.data;
  const budget = wordBudgets[capsule.level];
  const totalWords = proseFields(output).reduce((total, field) => total + wordCount(field), 0);
  if (!hasExactIdentity(capsule, output)
    || !hasAllowedSources(capsule, output)
    || totalWords < budget.minimum
    || totalWords > budget.maximum
    || violatesMedicalBoundary(capsule, output)
    || !hasFullSentenceGrounding(capsule, output)) {
    return rejected();
  }

  // Ensure key prose fields are present and not empty
  if (!output.summary?.trim() || !output.biologicalRole?.trim() || !output.whyMeasured?.trim()) {
    return rejected();
  }

  return { ok: true, value: output };
}
