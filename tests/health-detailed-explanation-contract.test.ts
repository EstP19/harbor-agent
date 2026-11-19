import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detailedExplanationCapsuleSchema,
  detailedExplanationOutputSchema,
  type DetailedExplanationCapsule,
} from '../agent/capabilities/health-detailed-explanation/schema.ts';
import {
  validateDetailedExplanationOutput,
} from '../agent/capabilities/health-detailed-explanation/guardrails.ts';
import { buildDetailedExplanationPrompt } from '../agent/capabilities/health-detailed-explanation/prompt.ts';

const groundedProseWords = ['approved', 'general', 'content', 'about', 'the', 'biological', 'role', 'and', 'measurement'];
const prose = (wordCount: number) =>
  Array.from({ length: wordCount }, (_, index) => groundedProseWords[index % groundedProseWords.length]).join(' ');

const languageGrounding = {
  es: { filler: 'informacion general sobre el marcador y la medicion', role: 'papel biologico general', measured: 'motivo general de medicion' },
  en: { filler: 'general information about the marker and measurement', role: 'the general biological role', measured: 'why the marker is measured' },
  nl: { filler: 'algemene informatie over de marker en de meting', role: 'het algemene biologische rol', measured: 'waarom de marker wordt gemeten' },
} as const;

function validCapsule(level: 'L1' | 'L2' | 'L3' = 'L1'): DetailedExplanationCapsule {
  return {
    contractVersion: 'health-detailed-explanation/v1',
    outputSchemaVersion: 'health-detailed-explanation-output/v1',
    idempotencyKey: 'idem-opaque-1',
    requestId: 'request-opaque-1',
    itemId: 'item-opaque-1',
    conceptCode: 'LOINC:718-7',
    displayName: 'Hemoglobin',
    languageCode: 'en',
    level,
    approvedContentBlocks: [{
      contentBlockId: 'block-opaque-1',
      contentVersionId: 'content-version-opaque-1',
      contentHash: 'sha256:approved-content',
      text: `${[117, 118, 179, 218, 318].map(count => `${prose(count)}.`).join(' ')} role. measurement.`,
    }],
    approvedSources: [{
      sourceRef: 'source-opaque-1',
      sourceVersionId: 'source-version-opaque-1',
      sourceContentHash: 'sha256:approved-source',
    }],
  };
}

function validOutput(level: 'L1' | 'L2' | 'L3' = 'L1') {
  const wordCount = level === 'L1' ? 120 : level === 'L2' ? 220 : 320;
  return {
    contractVersion: 'health-detailed-explanation/v1',
    outputSchemaVersion: 'health-detailed-explanation-output/v1',
    capabilityVersion: 'health-detailed-explanation-capability/v1',
    conceptCode: 'LOINC:718-7',
    languageCode: 'en',
    level,
    summary: prose(wordCount - 2),
    biologicalRole: 'role',
    whyMeasured: 'measurement',
    generalConsiderations: [],
    measurementNotes: [],
    limitations: [],
    sourceRefs: level === 'L1' ? [] : ['source-opaque-1'],
  };
}

test('health detailed explanation contract accepts only the non-personal capsule shape', () => {
  const result = detailedExplanationCapsuleSchema.safeParse(validCapsule());
  assert.equal(result.success, true);
  assert.equal(detailedExplanationCapsuleSchema.safeParse({ ...validCapsule(), languageCode: 'pt' }).success, false);
  assert.equal(detailedExplanationCapsuleSchema.safeParse({ ...validCapsule(), level: 'L4' }).success, false);
});

test('health detailed explanation contract never trusts fabricated dynamic content blocks', () => {
  const capsule = {
    ...validCapsule(),
    approvedContentBlocks: [{
      ...validCapsule().approvedContentBlocks[0],
      contentBlockId: 'dyn_block_LOINC_718_7',
      text: 'An approved sentence.',
    }],
  };

  assert.deepEqual(validateDetailedExplanationOutput(capsule, validOutput()), {
    ok: false,
    code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED',
  });
});

test('health detailed explanation contract rejects forbidden capsule bridges with strict schemas', () => {
  const forbiddenFields: Record<string, unknown> = {
    subjectId: 'subject-1',
    userId: 'user-1',
    observationId: 'observation-1',
    value: '13.5',
    unit: 'g/dL',
    range: '12-16',
    flag: 'HIGH',
    documentId: 'document-1',
    filename: 'report.pdf',
    extractedText: 'personal transcript',
    profile: { age: 40 },
    instructions: 'Explain this for me',
  };

  for (const [field, value] of Object.entries(forbiddenFields)) {
    assert.equal(
      detailedExplanationCapsuleSchema.safeParse({ ...validCapsule(), [field]: value }).success,
      false,
      `capsule must reject ${field}`,
    );
  }
});

test('health detailed explanation contract requires non-empty core prose while allowing unsupported arrays to be empty', () => {
  assert.equal(detailedExplanationOutputSchema.safeParse(validOutput()).success, true);
  for (const field of ['summary', 'biologicalRole', 'whyMeasured'] as const) {
    assert.equal(
      detailedExplanationOutputSchema.safeParse({ ...validOutput(), [field]: '  ' }).success,
      false,
      `${field} must contain narrative prose after trimming`,
    );
  }
  assert.equal(detailedExplanationOutputSchema.safeParse({
    ...validOutput(),
    generalConsiderations: [],
    measurementNotes: [],
    limitations: [],
  }).success, true, 'unsupported optional sections remain empty rather than invented');
  assert.equal(detailedExplanationOutputSchema.safeParse({ ...validOutput(), sourceRefs: undefined }).success, false);
  assert.equal(detailedExplanationOutputSchema.safeParse({ ...validOutput(), extra: 'unknown' }).success, false);
});

test('health detailed explanation contract validates exact identity, source subset, and word budgets', () => {
  for (const level of ['L1', 'L2', 'L3'] as const) {
    const accepted = validateDetailedExplanationOutput(validCapsule(level), validOutput(level));
    assert.equal(accepted.ok, true, `accepts ${level} at its lower word budget`);
  }

  const invalidCandidates = [
    { name: 'wrong concept', output: { ...validOutput(), conceptCode: 'LOINC:1234-5' } },
    { name: 'wrong language', output: { ...validOutput(), languageCode: 'es' } },
    { name: 'wrong level', output: { ...validOutput(), level: 'L2' } },
    { name: 'wrong output schema version', output: { ...validOutput(), outputSchemaVersion: 'health-detailed-explanation-output/v2' } },
    { name: 'invented source', output: { ...validOutput(), sourceRefs: ['source-not-supplied'] } },
    { name: 'under-budget prose', output: { ...validOutput(), summary: prose(117) } },
    { name: 'over-budget prose', output: { ...validOutput(), summary: prose(179) } },
  ];

  for (const { name, output } of invalidCandidates) {
    const result = validateDetailedExplanationOutput(validCapsule(), output);
    assert.deepEqual(result, { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, name);
  }
});

test('health detailed explanation contract rejects personal, diagnostic, risk, treatment, action, and urgency prose in every language', () => {
  const prohibitedProse = [
    ['en', 'your result means something'],
    ['es', 'tu resultado significa algo'],
    ['nl', 'JE RESULTAAT betekent iets'],
    ['en', 'the person was diagnosed with a condition'],
    ['es', 'este diagnóstico es importante'],
    ['nl', 'een diagnostische conclusie is belangrijk'],
    ['en', 'your risk of disease changes'],
    ['es', 'Su riesgo de enfermedad cambia'],
    ['nl', 'jouw risico op ziekte verandert'],
    ['en', 'treatment with medication is needed'],
    ['es', 'se necesita tratamiento con medicacion'],
    ['nl', 'behandeling met medicatie is nodig'],
    ['en', 'take a dose today'],
    ['es', 'toma una dosis hoy'],
    ['nl', 'neem vandaag een dosis'],
    ['en', 'you should see a doctor'],
    ['es', '¡Acude al médico!'],
    ['nl', 'u moet een arts raadplegen'],
    ['en', 'seek emergency care immediately'],
    ['es', 'busca atencion de emergencia inmediatamente'],
    ['nl', 'zoek onmiddellijk spoedzorg'],
    ['es', 'La glucosa alta confirma diabetes'],
    ['es', 'La glucosa alta demuestra enfermedad'],
    ['es', 'La glucosa alta demuestra una enfermedad'],
    ['es', 'La glucosa alta es prueba de diabetes'],
    ['es', 'La glucosa alta confirma que hay diabetes'],
    ['en', 'High glucose confirms diabetes'],
    ['en', 'High glucose demonstrates disease'],
    ['en', 'High glucose confirms a disease'],
    ['en', 'High glucose is consistent with diabetes'],
    ['en', 'High glucose confirms that diabetes is present'],
    ['nl', 'Hoge glucose bevestigt diabetes'],
    ['nl', 'Hoge glucose toont ziekte aan'],
    ['nl', 'Hoge glucose toont een ziekte aan'],
    ['nl', 'Hoge glucose is bewijs van diabetes'],
    ['nl', 'Hoge glucose bevestigt dat er diabetes is'],
  ] as const;

  for (const [languageCode, sentence] of prohibitedProse) {
    const capsule = { ...validCapsule(), languageCode };
    const result = validateDetailedExplanationOutput(capsule, {
      ...validOutput(),
      languageCode,
      summary: `${prose(119)} ${sentence}`,
    });
    assert.deepEqual(result, { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${languageCode}: ${sentence}`);
  }
});

test('health detailed explanation contract permits impersonal general medical education in every supported language', () => {
  const generalProse = [
    ['en', 'General information describes measurement variability without interpreting an individual result.'],
    ['es', 'La información general describe la variabilidad de las mediciones sin interpretar un resultado individual.'],
    ['nl', 'Algemene informatie beschrijft meetvariatie zonder een individueel resultaat te interpreteren.'],
    ['es', 'La glucosa participa en procesos biológicos generales y su medición puede variar.'],
    ['en', 'Glucose participates in general biological processes and its measurement can vary.'],
    ['nl', 'Glucose speelt een rol in algemene biologische processen en de meting kan variëren.'],
  ] as const;

  for (const [languageCode, sentence] of generalProse) {
    const grounding = languageGrounding[languageCode];
    const capsule = {
      ...validCapsule(),
      languageCode,
      displayName: sentence.startsWith('La ') ? 'Glucosa' : sentence.startsWith('Glucose') ? 'Glucose' : 'Marker',
      approvedContentBlocks: [{ ...validCapsule().approvedContentBlocks[0], text: `${`${grounding.filler} `.repeat(16)}. ${sentence} ${grounding.role}. ${grounding.measured}.` }],
    };
    const result = validateDetailedExplanationOutput(capsule, {
      ...validOutput(),
      languageCode,
      summary: `${`${grounding.filler} `.repeat(16)}. ${sentence}`,
      biologicalRole: grounding.role,
      whyMeasured: grounding.measured,
    });
    assert.equal(result.ok, true, `${languageCode}: permits impersonal education`);
  }
});

test('health detailed explanation contract rejects structural marker-to-disease assertions with unseen connective verbs', () => {
  const mutations = [
    ['es', 'La glucosa alta revela diabetes y el marcador establece enfermedad.'],
    ['es', 'La glucosa presagia hipertension.'],
    ['es', 'La glucosa es alta. Esto revela diabetes.'],
    ['es', 'El marcador delata una enfermedad.'],
    ['es', 'Un resultado bajo certifica diabetes.'],
    ['en', 'High glucose reveals diabetes and the marker establishes disease.'],
    ['en', 'Glucose heralds hypertension.'],
    ['en', 'Glucose is high. This reveals diabetes.'],
    ['en', 'The marker foreshadows a condition.'],
    ['en', 'A low result certifies illness.'],
    ['nl', 'Hoge glucose onthult diabetes en de marker stelt ziekte vast.'],
    ['nl', 'Glucose voorspelt hypertensie.'],
    ['nl', 'Glucose is hoog. Dit onthult diabetes.'],
    ['nl', 'De marker verraadt een aandoening.'],
    ['nl', 'Een laag resultaat certificeert ziekte.'],
  ] as const;

  for (const [languageCode, sentence] of mutations) {
    const capsule = { ...validCapsule(), languageCode, displayName: languageCode === 'es' ? 'Glucosa' : 'Glucose' };
    const result = validateDetailedExplanationOutput(capsule, {
      ...validOutput(),
      languageCode,
      summary: `${prose(119)} ${sentence}`,
    });
    assert.deepEqual(result, { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${languageCode}: ${sentence}`);
  }
});

test('health detailed explanation contract rejects concept and marker abnormal-state assertions even when approved content mentions the terms', () => {
  const cases = [
    ['es', 'Glucosa', 'La glucosa esta alta.'],
    ['es', 'Glucosa', 'El marcador aparece disminuido.'],
    ['es', 'Glucosa', 'El resultado esta aumentado.'],
    ['es', 'Glucosa', 'El valor es anormal.'],
    ['es', 'Glucosa', 'El nivel esta fuera de rango.'],
    ['en', 'Glucose', 'Glucose is elevated.'],
    ['en', 'Glucose', 'The marker appears decreased.'],
    ['en', 'Glucose', 'The result is increased.'],
    ['en', 'Glucose', 'The value is abnormal.'],
    ['en', 'Glucose', 'The level is low.'],
    ['nl', 'Glucose', 'Glucose is verhoogd.'],
    ['nl', 'Glucose', 'De marker lijkt verlaagd.'],
    ['nl', 'Glucose', 'Het resultaat is toegenomen.'],
    ['nl', 'Glucose', 'De waarde is abnormaal.'],
    ['nl', 'Glucose', 'Het niveau is laag.'],
  ] as const;
  for (const [languageCode, displayName, sentence] of cases) {
    const capsule = { ...validCapsule(), languageCode, displayName, approvedContentBlocks: [{ ...validCapsule().approvedContentBlocks[0], text: `${validCapsule().approvedContentBlocks[0].text} ${sentence}` }] };
    const result = validateDetailedExplanationOutput(capsule, { ...validOutput(), languageCode, summary: `${prose(119)} ${sentence}` });
    assert.deepEqual(result, { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${languageCode}: ${sentence}`);
  }
});

test('health detailed explanation contract rejects unapproved real and synthetic medical entities while accepting grounded education', () => {
  const cases = [
    ['es', 'Glucosa', ['La glucosa revela sepsis y el marcador establece leucemia.', 'La glucosa participa en zorbosis.'], 'La glucosa participa en procesos biologicos generales y la medicion puede variar.'],
    ['en', 'Glucose', ['Glucose reveals sepsis and the marker establishes leukemia.', 'Glucose participates in nexemia.'], 'Glucose participates in general biological processes and measurement can vary.'],
    ['nl', 'Glucose', ['Glucose onthult sepsis en de marker stelt leukemie vast.', 'Glucose speelt een rol in zorbieziekte.'], 'Glucose speelt een rol in algemene biologische processen en de meting kan varieren.'],
  ] as const;
  for (const [languageCode, displayName, unsafeSentences, safeSentence] of cases) {
    const grounding = languageGrounding[languageCode];
    const approved = `${`${grounding.filler} `.repeat(16)}. ${safeSentence} ${grounding.role}. ${grounding.measured}.`;
    const capsule = { ...validCapsule(), languageCode, displayName, approvedContentBlocks: [{ ...validCapsule().approvedContentBlocks[0], text: approved }] };
    for (const sentence of unsafeSentences) {
      const result = validateDetailedExplanationOutput(capsule, { ...validOutput(), languageCode, biologicalRole: grounding.role, whyMeasured: grounding.measured, summary: `${`${grounding.filler} `.repeat(16)}. ${sentence}` });
      assert.deepEqual(result, { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${languageCode}: ${sentence}`);
    }
    const educational = validateDetailedExplanationOutput(capsule, { ...validOutput(), languageCode, biologicalRole: grounding.role, whyMeasured: grounding.measured, summary: `${`${grounding.filler} `.repeat(16)}. ${safeSentence}` });
    assert.equal(educational.ok, true, `${languageCode}: grounded education`);
  }
});

test('health detailed explanation contract grounds each relation in one approved sentence', () => {
  const cases = [
    {
      languageCode: 'es' as const, displayName: 'Glucosa', unsafe: 'La glucosa revela sepsis.',
      safe: 'La glucosa afecta el metabolismo.', reversed: 'El metabolismo afecta la glucosa.', abnormal: 'La glucosa esta elevada.',
      approvedRelations: 'La glucosa revela variacion. La investigacion revela sepsis. La glucosa afecta el metabolismo. El metabolismo afecta la recuperacion. La investigacion afecta la glucosa. La glucosa esta elevada.',
      filler: 'informacion general sobre el marcador y la medicion', role: 'papel biologico general', measured: 'motivo general de medicion',
    },
    {
      languageCode: 'en' as const, displayName: 'Glucose', unsafe: 'Glucose reveals sepsis.',
      safe: 'Glucose affects metabolism.', reversed: 'Metabolism affects glucose.', abnormal: 'Glucose is elevated.',
      approvedRelations: 'Glucose reveals variation. Research reveals sepsis. Glucose affects metabolism. Metabolism affects recovery. Research affects glucose. Glucose is elevated.',
      filler: 'general information about the marker and measurement', role: 'the general biological role', measured: 'why the marker is measured',
    },
    {
      languageCode: 'nl' as const, displayName: 'Glucose', unsafe: 'Glucose onthult sepsis.',
      safe: 'Glucose beinvloedt metabolisme.', reversed: 'Metabolisme beinvloedt glucose.', abnormal: 'Glucose is verhoogd.',
      approvedRelations: 'Glucose onthult variatie. Onderzoek onthult sepsis. Glucose beinvloedt metabolisme. Metabolisme beinvloedt herstel. Onderzoek beinvloedt glucose. Glucose is verhoogd.',
      filler: 'algemene informatie over de marker en de meting', role: 'het algemene biologische rol', measured: 'waarom de marker wordt gemeten',
    },
  ] as const;
  for (const entry of cases) {
    const approved = `${`${entry.filler} `.repeat(16)}. ${entry.approvedRelations} ${entry.role}. ${entry.measured}.`;
    const capsule = { ...validCapsule(), languageCode: entry.languageCode, displayName: entry.displayName, approvedContentBlocks: [{ ...validCapsule().approvedContentBlocks[0], text: approved }] };
    const base = { ...validOutput(), languageCode: entry.languageCode, biologicalRole: entry.role, whyMeasured: entry.measured };

    const unsafe = validateDetailedExplanationOutput(capsule, { ...base, summary: `${`${entry.filler} `.repeat(16)}. ${entry.unsafe}` });
    assert.deepEqual(unsafe, { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${entry.languageCode}: cross-sentence relation`);

    const safe = validateDetailedExplanationOutput(capsule, { ...base, summary: `${`${entry.filler} `.repeat(16)}. ${entry.safe}` });
    assert.equal(safe.ok, true, `${entry.languageCode}: exact same-sentence extraction`);

    const reversed = validateDetailedExplanationOutput(capsule, { ...base, summary: `${entry.filler} `.repeat(16), generalConsiderations: [entry.reversed] });
    assert.deepEqual(reversed, { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${entry.languageCode}: reversed array-entry relation`);

    const abnormal = validateDetailedExplanationOutput(capsule, { ...base, summary: `${`${entry.filler} `.repeat(16)}. ${entry.abnormal}` });
    assert.deepEqual(abnormal, { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${entry.languageCode}: abnormal state remains rejected`);
  }
});

const scopeGroundingCases = [
  {
    languageCode: 'es' as const,
    displayName: 'Glucosa',
    filler: 'informacion general sobre el marcador y la medicion',
    role: 'papel biologico general sobre la medicion',
    measured: 'motivo general para la medicion del marcador',
    approved: [
      'Es falso que la glucosa revela sepsis.',
      'Si la glucosa revelara sepsis, seria una afirmacion hipotetica.',
      'El articulo cuestiona la afirmacion de que la glucosa revela sepsis.',
      'Puede ser que la glucosa revela sepsis.',
    ],
    extracted: 'La glucosa revela sepsis.',
  },
  {
    languageCode: 'en' as const,
    displayName: 'Glucose',
    filler: 'general information about the marker and measurement',
    role: 'the general biological role in measurement',
    measured: 'why the marker is measured in general',
    approved: [
      'It is false that glucose reveals sepsis.',
      'If glucose revealed sepsis, the statement would be hypothetical.',
      'The article disputes the claim that glucose reveals sepsis.',
      'It may be that glucose reveals sepsis.',
    ],
    extracted: 'Glucose reveals sepsis.',
  },
  {
    languageCode: 'nl' as const,
    displayName: 'Glucose',
    filler: 'algemene informatie over de marker en de meting',
    role: 'het algemene biologische rol bij de meting',
    measured: 'waarom de marker in het algemeen wordt gemeten',
    approved: [
      'Het is onjuist dat glucose sepsis onthult.',
      'Als glucose sepsis zou onthullen, zou de bewering hypothetisch zijn.',
      'Het artikel betwist de bewering dat glucose sepsis onthult.',
      'Het kan zijn dat glucose sepsis onthult.',
    ],
    extracted: 'Glucose sepsis onthult.',
  },
] as const;

function scopedGroundingFixture(entry: typeof scopeGroundingCases[number]) {
  const fillerSentence = `${entry.filler} `.repeat(15).trim();
  const approvedText = `${fillerSentence}. ${entry.approved.join(' ')} ${entry.role}. ${entry.measured}.`;
  const capsule = {
    ...validCapsule(),
    languageCode: entry.languageCode,
    displayName: entry.displayName,
    approvedContentBlocks: [{ ...validCapsule().approvedContentBlocks[0], text: approvedText }],
  };
  const base = {
    ...validOutput(),
    languageCode: entry.languageCode,
    summary: fillerSentence,
    biologicalRole: entry.role,
    whyMeasured: entry.measured,
  };
  return { fillerSentence, capsule, base };
}

for (const { scope, approvedIndex, extracted } of [
  { scope: 'negation', approvedIndex: 0, extracted: 'Glucose reveals sepsis.' },
  { scope: 'conditional', approvedIndex: 1, extracted: 'Glucose revealed sepsis.' },
  { scope: 'attribution', approvedIndex: 2, extracted: 'Glucose reveals sepsis.' },
  { scope: 'modal uncertainty', approvedIndex: 3, extracted: 'Glucose reveals sepsis.' },
] as const) {
  test(`health detailed explanation contract rejects dropped ${scope} scope`, () => {
    const entry = scopeGroundingCases[1];
    const { fillerSentence, capsule, base } = scopedGroundingFixture(entry);
    const approvedSentence = entry.approved[approvedIndex];
    const scopedCapsule = {
      ...capsule,
      approvedContentBlocks: [{ ...capsule.approvedContentBlocks[0], text: `${fillerSentence}. ${approvedSentence} ${entry.role}. ${entry.measured}.` }],
    };
    const result = validateDetailedExplanationOutput(scopedCapsule, { ...base, summary: `${fillerSentence}. ${extracted}` });
    assert.deepEqual(result, { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, scope);
  });
}

test('health detailed explanation contract requires complete approved sentences for array entries', () => {
  const entry = scopeGroundingCases[1];
  const { capsule, base } = scopedGroundingFixture(entry);
  const result = validateDetailedExplanationOutput(capsule, { ...base, generalConsiderations: [entry.extracted] });

  assert.deepEqual(result, { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' });
});

test('health detailed explanation contract accepts exact full-sentence ES, EN, and NL controls', () => {
  for (const entry of scopeGroundingCases) {
    const { fillerSentence, capsule, base } = scopedGroundingFixture(entry);
    const result = validateDetailedExplanationOutput(capsule, { ...base, summary: `${fillerSentence}. ${entry.approved.join(' ')}` });

    assert.equal(result.ok, true, entry.languageCode);
  }
});

const modalityGroundingCases = [
  { languageCode: 'es' as const, displayName: 'Glucosa', filler: 'informacion general sobre el marcador y la medicion', stem: 'La glucosa afecta el metabolismo', arrayStem: 'La glucosa participa en procesos biologicos', normalizedQuestion: 'La glucosa, afecta   el metabolismo ?', role: 'papel biologico general sobre la medicion', measured: 'motivo general para la medicion del marcador' },
  { languageCode: 'en' as const, displayName: 'Glucose', filler: 'general information about the marker and measurement', stem: 'Glucose affects the metabolism', arrayStem: 'Glucose participates in biological processes', normalizedQuestion: 'Glucose, affects   the metabolism ?', role: 'the general biological role in measurement', measured: 'why the marker is measured in general' },
  { languageCode: 'nl' as const, displayName: 'Glucose', filler: 'algemene informatie over de marker en de meting', stem: 'Glucose beinvloedt het metabolisme', arrayStem: 'Glucose speelt een rol in biologische processen', normalizedQuestion: 'Glucose, beinvloedt   het metabolisme ?', role: 'het algemene biologische rol bij de meting', measured: 'waarom de marker in het algemeen wordt gemeten' },
] as const;

test('health detailed explanation contract preserves question, declaration, and exclamation modality in direct and core prose', () => {
  for (const entry of modalityGroundingCases) {
    const fillerSentence = `${entry.filler} `.repeat(15).trim();
    const base = { ...validOutput(), languageCode: entry.languageCode, summary: fillerSentence, biologicalRole: entry.role, whyMeasured: entry.measured };
    const withApproved = (sentence: string, role = `${entry.role}.`) => ({
      ...validCapsule(),
      languageCode: entry.languageCode,
      displayName: entry.displayName,
      approvedContentBlocks: [{ ...validCapsule().approvedContentBlocks[0], text: `${fillerSentence}. ${sentence} ${role} ${entry.measured}.` }],
    });

    assert.deepEqual(validateDetailedExplanationOutput(withApproved(`${entry.stem}?`), { ...base, summary: `${fillerSentence}. ${entry.stem}.` }), { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${entry.languageCode}: question cannot ground declaration`);
    assert.equal(validateDetailedExplanationOutput(withApproved(`${entry.stem}?`), { ...base, summary: `${fillerSentence}. ${entry.stem}?` }).ok, true, `${entry.languageCode}: exact question`);
    assert.equal(validateDetailedExplanationOutput(withApproved(`${entry.stem}.`), { ...base, summary: `${fillerSentence}. ${entry.stem}.` }).ok, true, `${entry.languageCode}: exact declaration`);
    assert.equal(validateDetailedExplanationOutput(withApproved(entry.normalizedQuestion), { ...base, summary: `${fillerSentence}. ${entry.stem}?` }).ok, true, `${entry.languageCode}: punctuation and whitespace normalization`);
    assert.deepEqual(validateDetailedExplanationOutput(withApproved(`${entry.stem}!`), { ...base, summary: `${fillerSentence}. ${entry.stem}.` }), { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${entry.languageCode}: exclamation cannot ground declaration`);
    assert.deepEqual(validateDetailedExplanationOutput(withApproved(`${entry.stem}!`), { ...base, summary: `${fillerSentence}. ${entry.stem}?` }), { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${entry.languageCode}: exclamation cannot ground question`);
    assert.equal(validateDetailedExplanationOutput(withApproved(`${entry.stem}!`), { ...base, summary: `${fillerSentence}. ${entry.stem}!` }).ok, true, `${entry.languageCode}: exact exclamation`);

    const coreCapsule = withApproved(`${entry.stem}.`, `${entry.role}?`);
    assert.deepEqual(validateDetailedExplanationOutput(coreCapsule, { ...base, summary: `${fillerSentence}. ${entry.stem}.`, biologicalRole: `${entry.role}.` }), { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${entry.languageCode}: core question cannot ground declaration`);
    assert.equal(validateDetailedExplanationOutput(coreCapsule, { ...base, summary: `${fillerSentence}. ${entry.stem}.`, biologicalRole: `${entry.role}?` }).ok, true, `${entry.languageCode}: exact core question`);
  }
});

test('health detailed explanation contract preserves terminal modality for array entries', () => {
  for (const entry of modalityGroundingCases) {
    const fillerSentence = `${entry.filler} `.repeat(15).trim();
    const capsule = {
      ...validCapsule(),
      languageCode: entry.languageCode,
      displayName: entry.displayName,
      approvedContentBlocks: [{ ...validCapsule().approvedContentBlocks[0], text: `${fillerSentence}. ${entry.stem}. ${entry.role}. ${entry.measured}. ${entry.arrayStem}?` }],
    };
    const base = { ...validOutput(), languageCode: entry.languageCode, summary: `${fillerSentence}. ${entry.stem}.`, biologicalRole: entry.role, whyMeasured: entry.measured };

    assert.deepEqual(validateDetailedExplanationOutput(capsule, { ...base, generalConsiderations: [`${entry.arrayStem}.`] }), { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' }, `${entry.languageCode}: array question cannot ground declaration`);
    assert.equal(validateDetailedExplanationOutput(capsule, { ...base, generalConsiderations: [`${entry.arrayStem}?`] }).ok, true, `${entry.languageCode}: exact array question`);
  }
});

test('health detailed explanation prompt requires full-sentence extraction with logical scope intact', () => {
  const { systemPrompt } = buildDetailedExplanationPrompt(validCapsule());

  assert.match(systemPrompt, /copy each selected approved-content sentence in full/i);
  assert.match(systemPrompt, /do not extract a clause/i);
  assert.match(systemPrompt, /negation, modality, conditionals, or attribution/i);
  assert.doesNotMatch(systemPrompt, /articles may be added or omitted/i);
});
