import assert from 'node:assert/strict';
import test from 'node:test';

import { createDoctorQuestionsHandler } from '../agent/capabilities/health-doctor-questions/handler.ts';
import { validateDoctorQuestionsOutput } from '../agent/capabilities/health-doctor-questions/validator.ts';
import { doctorQuestionsCapsuleSchema, type DoctorQuestionsCapsule } from '../agent/capabilities/health-doctor-questions/schema.ts';
import { handleDoctorQuestionsHttpRequest, readDoctorQuestionsBody } from '../agent/capabilities/health-doctor-questions/route.ts';
import { pool, query } from '../lib/db.ts';

const capsule: DoctorQuestionsCapsule = {
  contractVersion: 'health-doctor-questions/v2', requestKey: 'a'.repeat(64),
  languageCode: 'nl', level: 'L2', targetQuantity: 3,
  topics: [{ conceptCode: 'GLUCOSE', approvedName: 'Glucose', generalTopic: 'Glucose heeft een algemene rol in de energiehuishouding.' }],
};

test('doctor questions capsule accepts only approved general topic fields', () => {
  assert.equal(doctorQuestionsCapsuleSchema.safeParse(capsule).success, true);
  for (const forbidden of ['idempotencyKey', 'manifestId', 'subjectId', 'userId', 'sessionId', 'value', 'unit', 'range', 'flag', 'documentId', 'profile', 'extractedText', 'topicTitle', 'topicSummary']) {
    assert.equal(doctorQuestionsCapsuleSchema.safeParse({ ...capsule, [forbidden]: 'forbidden' }).success, false, forbidden);
  }
});

test('doctor question validator accepts grounded questions and rejects wrong language and unsafe assertions', () => {
  const probes = [
    { languageCode: 'es' as const, approvedName: 'Glucosa', generalTopic: 'La glucosa participa en el metabolismo energético.', good: '¿Qué función general tiene la glucosa en el metabolismo energético?', bad: ['La glucosa confirma diabetes.', 'Qué función general tiene la glucosa?', '¿Qué role does glucosa have?', '¿Qué función general tiene el metabolismo energético?', '¿Qué tratamiento, dosis, urgencia o riesgo tiene la glucosa?'] },
    { languageCode: 'en' as const, approvedName: 'Glucose', generalTopic: 'Glucose participates in energy metabolism.', good: 'What general role does glucose have in energy metabolism?', bad: ['Glucose requires treatment.', 'Glucose participates in energy metabolism?', 'What función tiene glucose?', 'What general role does energy metabolism have?', 'What diagnosis, dose, urgency, or risk does glucose confirm?'] },
    { languageCode: 'nl' as const, approvedName: 'Glucose', generalTopic: 'Glucose speelt een rol in de energiehuishouding.', good: 'Welke algemene rol heeft glucose in de energiehuishouding?', bad: ['Glucose verhoogt uw risico.', 'Glucose speelt een rol in de energiehuishouding?', 'Welke general role does glucose have?', 'Welke rol heeft de energiehuishouding?', 'Welke diagnose, dosering, spoed of risico bevestigt glucose?'] },
  ];
  for (const probe of probes) {
    const input = { ...capsule, languageCode: probe.languageCode, targetQuantity: 3, topics: [{ conceptCode: 'GLUCOSE', approvedName: probe.approvedName, generalTopic: probe.generalTopic }] };
    assert.equal(validateDoctorQuestionsOutput(input, { questions: [probe.good, probe.good, probe.good] }).ok, true);
    for (const bad of probe.bad) assert.equal(validateDoctorQuestionsOutput(input, { questions: [bad, probe.good, probe.good] }).ok, false, `${probe.languageCode}: ${bad}`);
  }
  assert.equal(validateDoctorQuestionsOutput(capsule, { questions: ['What is glucose?', 'What is glucose?', 'What is glucose?'] }).ok, false);

  const es = { ...capsule, languageCode: 'es' as const, topics: [{ conceptCode: 'GLUCOSE', approvedName: 'Glucosa', generalTopic: 'La glucosa participa en el metabolismo energético.' }] };
  for (const bad of [
    'Qué función general tiene la glucosa en el metabolismo energético?',
    '¿Qué role does glucosa have?',
    '¿Qué relación tiene la glucosa con el cáncer?',
    '¿Qué función general tiene el metabolismo energético?',
  ]) assert.equal(validateDoctorQuestionsOutput(es, { questions: [bad, bad, bad] }).ok, false, bad);

  const exactLanguageProbes = [
    { input: { ...capsule, languageCode: 'es' as const, topics: [{ conceptCode: 'GLUCOSE', approvedName: 'Glucosa', generalTopic: 'La glucosa participa en el metabolismo energético.' }] }, good: '¿Qué es la glucosa?', mixed: ['¿Qué is la glucosa?', '¿Qué do la glucosa?', '¿Qué the glucosa?'] },
    { input: { ...capsule, languageCode: 'en' as const, topics: [{ conceptCode: 'GLUCOSE', approvedName: 'Glucose', generalTopic: 'Glucose participates in energy metabolism.' }] }, good: 'What is glucose?', mixed: ['What es glucose?', 'What la glucose?', 'What het glucose?'] },
    { input: { ...capsule, languageCode: 'nl' as const, topics: [{ conceptCode: 'GLUCOSE', approvedName: 'Glucose', generalTopic: 'Glucose speelt een rol in de energiehuishouding.' }] }, good: 'Wat is glucose?', mixed: ['Wat do glucose?', 'Wat the glucose?', 'Wat la glucose?'] },
  ];
  for (const probe of exactLanguageProbes) {
    assert.equal(validateDoctorQuestionsOutput(probe.input, { questions: [probe.good, probe.good, probe.good] }).ok, true, probe.good);
    for (const mixed of probe.mixed) {
      assert.equal(validateDoctorQuestionsOutput(probe.input, { questions: [mixed, probe.good, probe.good] }).ok, false, mixed);
    }
  }
  const foreignWordInApprovedTopic = {
    ...capsule,
    languageCode: 'es' as const,
    topics: [{ conceptCode: 'GLUCOSE', approvedName: 'Glucosa', generalTopic: 'La glucosa is general.' }],
  };
  assert.equal(validateDoctorQuestionsOutput(foreignWordInApprovedTopic, { questions: ['¿Qué is la glucosa?', '¿Qué es la glucosa?', '¿Qué es la glucosa?'] }).ok, false);
  const approvedShortMedicalName = { ...capsule, languageCode: 'en' as const, topics: [{ conceptCode: 'ES', approvedName: 'ES', generalTopic: 'ES' }] };
  assert.equal(validateDoctorQuestionsOutput(approvedShortMedicalName, { questions: ['What is ES?', 'What is ES?', 'What is ES?'] }).ok, true);
});

test('database abort after a delayed pool connection executes zero SQL', async () => {
  const originalConnect = pool.connect.bind(pool);
  let resolveConnect!: (client: unknown) => void;
  let sqlCalls = 0;
  const releases: unknown[] = [];
  const client = {
    query: async () => { sqlCalls += 1; return { rows: [] }; },
    release: (destroy?: boolean) => { releases.push(destroy); },
  };
  (pool as unknown as { connect: () => Promise<unknown> }).connect = () => new Promise(resolve => { resolveConnect = resolve; });
  const controller = new AbortController();
  try {
    const pending = query('SELECT 1', [], controller.signal);
    controller.abort();
    resolveConnect(client);
    await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
    assert.equal(sqlCalls, 0);
    assert.deepEqual(releases, [true]);
  } finally {
    (pool as unknown as { connect: typeof pool.connect }).connect = originalConnect;
  }
});

test('approved medication-review topic can be discussed without allowing new clinical assertions', () => {
  const input = { ...capsule, languageCode: 'en' as const, topics: [{ conceptCode: 'CONSULT_REASON_MEDREVIEW', approvedName: 'Medication and treatment review', generalTopic: 'Medication and treatment review' }] };
  const good = 'What is medication and treatment review?';
  assert.equal(validateDoctorQuestionsOutput(input, { questions: [good, good, good] }).ok, true);
  for (const bad of ['What diagnosis does medication and treatment review confirm?', 'What dose is medication and treatment review?', 'What is medication and treatment review for your diabetes?']) {
    assert.equal(validateDoctorQuestionsOutput(input, { questions: [bad, good, good] }).ok, false);
  }
});

test('all seven Harbor languages accept general questions and reject new clinical content', () => {
  for (const [languageCode, approvedName, good, bad] of [
    ['es', 'Salud', '¿Qué es la salud?', '¿Qué cáncer tiene la salud?'],
    ['en', 'Health', 'What is health?', 'What cancer does health confirm?'],
    ['nl', 'Gezondheid', 'Wat is gezondheid?', 'Welke diagnose bevestigt gezondheid?'],
    ['fr', 'Santé', 'Qu’est-ce que la santé?', 'Quel cancer confirme la santé?'],
    ['de', 'Gesundheit', 'Was ist Gesundheit?', 'Welche Krankheit ist Gesundheit?'],
    ['pt', 'Saúde', 'O que é a saúde?', 'Qual câncer a saúde confirma?'],
    ['pap', 'Salú', 'Kiko ta salú?', 'Kiko ta salú diabetes?'],
  ] as const) {
    const input = { ...capsule, languageCode, topics: [{ conceptCode: 'HEALTH', approvedName, generalTopic: approvedName }] };
    assert.equal(doctorQuestionsCapsuleSchema.safeParse(input).success, true);
    assert.equal(validateDoctorQuestionsOutput(input, { questions: [good, good, good] }).ok, true, languageCode);
    assert.equal(validateDoctorQuestionsOutput(input, { questions: [bad, good, good] }).ok, false, languageCode);
  }
});

test('bounded repair retains only independently validated questions and finalizes once', async () => {
  let calls = 0;
  const finalized: unknown[] = [];
  const good = ['Wat is glucose?', 'Welke rol heeft glucose?', 'Welke algemene rol heeft glucose in de energiehuishouding?'];
  const handler = createDoctorQuestionsHandler({
    reservation: { claim: async () => ({ kind: 'claimed' as const, claimToken: 'claim' }), finalize: async value => { finalized.push(value); } },
    completion: async () => ++calls === 1
      ? { questions: [good[0], good[1], 'Welke diagnose bevestigt glucose?'] }
      : { questions: [good[0], good[2], 'Welke dosis heeft glucose?'] },
  });
  const result = await handler(capsule);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.output.questions, good);
  assert.equal(calls, 2);
  assert.equal(finalized.length, 1);
  assert.equal((finalized[0] as { status: string }).status, 'completed');
});

test('doctor questions completed replay is independently revalidated without another completion', async () => {
  let completions = 0;
  const handler = createDoctorQuestionsHandler({
    reservation: {
      claim: async () => ({ kind: 'duplicate' as const, status: 'completed' as const, output: { questions: ['Welke diagnose bevestigt glucose?', 'Welke diagnose bevestigt glucose?', 'Welke diagnose bevestigt glucose?'] } }),
      finalize: async () => undefined,
    },
    completion: async () => { completions += 1; return {}; },
  });
  assert.deepEqual(await handler(capsule), { ok: false, code: 'DOCTOR_QUESTIONS_OUTPUT_REJECTED' });
  assert.equal(completions, 0);
});

test('doctor questions finalization is aborted below the lease', async () => {
  let finalizerAborted = false;
  const handler = createDoctorQuestionsHandler({
    timeoutMs: 20,
    finalizeTimeoutMs: 15,
    reservation: {
      claim: async () => ({ kind: 'claimed' as const, claimToken: 'c' }),
      finalize: async (_input, signal) => {
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
          finalizerAborted = true;
          reject(new Error('aborted'));
        }, { once: true }));
      },
    },
    completion: async () => ({ questions: ['not a question', 'not a question', 'not a question'] }),
  });
  assert.deepEqual(await handler(capsule), { ok: false, code: 'DOCTOR_QUESTIONS_OUTPUT_REJECTED' });
  assert.equal(finalizerAborted, true);
});

test('doctor questions completion is aborted below the reservation lease and cannot overlap a second completion', async () => {
  let completions = 0;
  let running = false;
  const handler = createDoctorQuestionsHandler({
    timeoutMs: 20,
    reservation: {
      claim: async () => running ? { kind: 'duplicate' as const, status: 'running' as const } : (running = true, { kind: 'claimed' as const, claimToken: 'c' }),
      finalize: async () => { running = false; },
    },
    completion: async (_prompt, signal) => {
      completions += 1;
      await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 100); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }); });
      return { questions: ['Welke rol heeft glucose?', 'Welke rol heeft glucose?', 'Welke rol heeft glucose?'] };
    },
  });
  const first = handler(capsule);
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await handler(capsule);
  assert.equal((await first).ok, false);
  assert.equal(second.ok, false);
  assert.equal(completions, 1);
});

test('doctor questions HTTP boundary requires service auth and enforces a bounded body', async () => {
  const handler = async () => ({ ok: true as const, output: { questions: ['Een?', 'Twee?', 'Drie?'] } });
  const unauthorized = await handleDoctorQuestionsHttpRequest({ authorization: undefined, serviceToken: 'secret', bodyText: JSON.stringify(capsule), handler });
  assert.equal(unauthorized.statusCode, 401);
  const accepted = await handleDoctorQuestionsHttpRequest({ authorization: 'Bearer secret', serviceToken: 'secret', bodyText: JSON.stringify(capsule), handler });
  assert.equal(accepted.statusCode, 200);
  const oversized = await readDoctorQuestionsBody((async function* () { yield 'x'.repeat(1025); })(), 1024);
  assert.deepEqual(oversized, { ok: false, code: 'DOCTOR_QUESTIONS_PAYLOAD_TOO_LARGE' });
});

test('doctor questions concurrent duplicate and lost-success replay never invoke completion twice', async () => {
  let completions = 0;
  let stored: unknown;
  let running = false;
  const reservation = {
    claim: async () => stored ? ({ kind: 'duplicate' as const, status: 'completed' as const, output: stored }) : running ? ({ kind: 'duplicate' as const, status: 'running' as const }) : (running = true, { kind: 'claimed' as const, claimToken: 'claim' }),
    finalize: async (input: { status: string; output?: unknown }) => { running = false; if (input.status === 'completed') stored = input.output; },
  };
  const handler = createDoctorQuestionsHandler({
    reservation,
    completion: async () => { completions += 1; return { questions: ['Welke algemene rol heeft glucose in de energiehuishouding?', 'Welke algemene rol heeft glucose in de energiehuishouding?', 'Welke algemene rol heeft glucose in de energiehuishouding?'] }; },
  });
  const [first, concurrent] = await Promise.all([handler(capsule), handler(capsule)]);
  assert.equal(first.ok, true);
  assert.deepEqual(concurrent, { ok: false, code: 'DOCTOR_QUESTIONS_DUPLICATE' });
  const replay = await handler(capsule);
  assert.equal(replay.ok, true);
  assert.equal(completions, 1);
});
