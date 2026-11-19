import type { DoctorQuestionsCapsule, DoctorQuestionsOutput } from './schema.ts';

type Language = DoctorQuestionsCapsule['languageCode'];

const unsafe = /\b(diagnos|diabet|c[aá]ncer|krebs|malign|disease|ziekt|krank|condition|confirm|bevestig|treat|tratam|traitement|behandl|dose|dosis|dosering|dosage|posolog|medicament|medication|medicin|drug|farmac|urgent|urgenc|urgence|emerg|spoed|notfall|risk|riesg|risico|risque|risco|risik|recommend|recomendar|aanbevel|should|debe|moet|you have|tienes|u heeft|your|tu|uw)\w*/iu;


// Format: every question must use an interrogative opener in the correct language
const interrogative: Record<Language, RegExp> = {
  es: /^¿(?:qué|cuál|cuáles|cómo|por qué|puede|pueden|tiene|tienen|qué tan|en qué|cuándo|dónde|debo|debería)(?=\s)[^.!]*\?$/iu,
  en: /^(?:what|which|how|why|can|could|does|do|is|are|in what|when|where|should)(?=\s)[^.!]*\?$/iu,
  nl: /^(?:wat|welke|hoe|waarom|kan|kunnen|heeft|is|zijn|in hoeverre|wanneer|waar|moet)(?=\s)[^.!]*\?$/iu,
  fr: /^(?:qu['’]est-ce que|en quoi|quel|quelle|quels|quelles|comment|pourquoi|que|peut|quand)(?=\s)[^.!]*\?$/iu,
  de: /^(?:was|welche|welcher|welches|wie|warum|kann|können|ist|sind|wann)(?=\s)[^.!]*\?$/iu,
  pt: /^(?:o que|qual|quais|como|por que|pode|podem|quando)(?=\s)[^.!]*\?$/iu,
  pap: /^(?:kiko|kon|pakon|kua|kuanto|por|ki)(?=\s)[^.!]*\?$/iu,
};

// Language purity: reject obvious foreign function words in the question
const foreignLanguageWords: Record<Language, RegExp> = {
  es: /\b(what|which|how|why|does|do|could|have|has|is|are|the|welke|waarom|heeft|kunnen)\b/iu,
  en: /\b(que|cual|cuales|como|funcion|tiene|es|son|la|el|los|las|welke|waarom|heeft|kunnen|het)\b/iu,
  nl: /\b(what|which|why|does|do|could|have|has|are|the|que|cual|cuales|como|funcion|tiene|son|la|los|las)\b/iu,
  fr: /\b(what|which|why|does|could|welke|waarom|tiene|cuales)\b/iu,
  de: /\b(what|which|why|does|could|welke|waarom|tiene|cuales|pourquoi)\b/iu,
  pt: /\b(what|which|why|does|could|welke|waarom|tiene|cuales|pourquoi)\b/iu,
  pap: /\b(what|which|why|does|could|welke|waarom|tiene|cuales|pourquoi)\b/iu,
};

const normalize = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const tokens = (text: string) => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
const grammar: Record<Language, Set<string>> = {
  es: new Set('que cual cuales como por puede pueden tiene tienen funcion general papel relacion se en el la los las del de un una es son y con sobre para al participa cuerpo persona paciente organismo significa consiste importancia aspectos incluye informacion preparar hablar preguntas llevar objetivo'.split(' ')),
  en: new Set('what which how why can could does do is are general role have has the a an in on of for and with participate participates discussed mean means involve involves include includes body person patient importance purpose information prepare preparation about as be being done during discuss'.split(' ')),
  nl: new Set('wat welke hoe waarom kan kunnen heeft hebben is zijn algemene rol de het een in van voor en met speelt betekent houdt inhoudt omvat belang doel informatie voorbereiden voorbereiding bespreken tijdens over bij persoon lichaam patient'.split(' ')),
  fr: new Set('qu est ce que quoi quel quelle quels quelles comment pourquoi peut peuvent quand le la les un une des du de a au aux et ou en pour sur avec dans role general generale est sont signifie consiste comprend importance objectif objectifs information informations preparer preparation discuter personne patient corps'.split(' ')),
  de: new Set('was welche welcher welches wie warum kann konnen ist sind wann der die das ein eine einer eines dem den des und oder in von fur mit uber bei allgemeine allgemeinen rolle bedeutet umfasst beinhaltet bedeutung ziel information informationen vorbereiten vorbereitung besprechen person patient korper'.split(' ')),
  pt: new Set('o que qual quais como por pode podem quando a os as um uma uns umas de do da dos das e ou em no na nos nas para sobre com papel geral funcao e sao significa consiste inclui importancia objetivo informacao preparar preparacao conversar pessoa paciente corpo'.split(' ')),
  pap: new Set('kiko kon pakon kua kuanto por ki ta e un di i o na den pa ku riba general rol funshon nifikashon nifik a objetivo importancia informashon prepara preparashon papia persona hende pasiente kurpa'.split(' ')),
};
export function doctorQuestionGrammar(language: Language): string[] {
  return [...grammar[language]];
}
const sameGroundedWord = (left: string, right: string) => left === right
  || (left.length >= 5 && right.length >= 5 && (left.startsWith(right) || right.startsWith(left)));

function isGrounded(language: Language, question: string, topics: DoctorQuestionsCapsule['topics']): boolean {
  const questionTokens = tokens(question);
  return topics.some(topic => {
    const names = tokens(topic.approvedName).filter(token => token.length >= 2);
    if (!names.length || !names.every(name => questionTokens.some(word => sameGroundedWord(word, name)))) return false;
    const approved = tokens(`${topic.approvedName} ${topic.generalTopic}`);
    return questionTokens.every(word => grammar[language].has(word)
      || approved.some(token => sameGroundedWord(word, token)));
  });
}

function hasForeignWord(languageCode: Language, question: string, topics: DoctorQuestionsCapsule['topics']): boolean {
  const approvedTokens = new Set(topics.flatMap(t => tokens(t.approvedName)));
  const qTokens = tokens(question);
  return qTokens.some(tok => !approvedTokens.has(tok) && foreignLanguageWords[languageCode].test(tok));
}

export function validateDoctorQuestionsOutput(capsule: DoctorQuestionsCapsule, output: DoctorQuestionsOutput): { ok: true } | { ok: false; code: string } {
  if (!output || !Array.isArray(output.questions)) return { ok: false, code: 'SCHEMA' };
  if (output.questions.length !== capsule.targetQuantity) return { ok: false, code: 'QUANTITY' };
  for (const question of output.questions) {
    if (typeof question !== 'string') return { ok: false, code: 'SCHEMA' };
    const withoutApprovedName = capsule.topics.reduce((text, topic) => text.replace(
      new RegExp(topic.approvedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), ''), question);
    if (unsafe.test(withoutApprovedName)) {
      console.warn('[validateDoctorQuestionsOutput] Triggered unsafe:', question.match(unsafe)?.[0], 'in:', question);
      return { ok: false, code: 'SAFETY' };
    }
    if (!interrogative[capsule.languageCode].test(question) || hasForeignWord(capsule.languageCode, question, capsule.topics)) {
      console.warn('[validateDoctorQuestionsOutput] Triggered language/format:', question);
      return { ok: false, code: 'LANGUAGE' };
    }
    if (!isGrounded(capsule.languageCode, question, capsule.topics)) return { ok: false, code: 'GROUNDING' };
  }
  return { ok: true };
}
