import { createRequire } from 'node:module';
import { mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorker, OEM, PSM } from 'tesseract.js';

const require = createRequire(import.meta.url);
// Resolve model assets only when OCR is requested. A packaging problem must not
// prevent unrelated capabilities, such as KB explanations, from starting.
function bundledModelPaths() { return {
  eng: require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'),
  nld: require.resolve('@tesseract.js-data/nld/4.0.0_best_int/nld.traineddata.gz'),
  spa: require.resolve('@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz'),
  fra: require.resolve('@tesseract.js-data/fra/4.0.0_best_int/fra.traineddata.gz'),
  deu: require.resolve('@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz'),
  por: require.resolve('@tesseract.js-data/por/4.0.0_best_int/por.traineddata.gz'),
}; }
// Papiamento shares these Latin characters; no dedicated Tesseract model exists.
// Disable word dictionaries so unfamiliar Papiamento and clinical words are not forced into another language.
export const FUNCTIONAL_OCR_LANGUAGES = 'nld+eng+spa+fra+deu+por';
const modelDirectory = join(tmpdir(), 'harbor-ocr-models-v1');
const installedModels = new Map<string, Promise<void>>();

export async function createLocalOcrWorker(languages: string) {
  const codes = [...new Set(languages.split('+'))];
  const modelPaths = bundledModelPaths();
  await mkdir(modelDirectory, { recursive: true });
  await Promise.all(codes.map(async code => {
    if (!Object.hasOwn(modelPaths, code)) throw Error('OCR_LANGUAGE_UNSUPPORTED');
    let installed = installedModels.get(code);
    if (!installed) {
      installed = copyFile(modelPaths[code as keyof typeof modelPaths], join(modelDirectory, `${code}.traineddata.gz`));
      installedModels.set(code, installed);
      installed.catch(() => installedModels.delete(code));
    }
    await installed;
  }));
  const worker = await createWorker(codes, OEM.LSTM_ONLY, { langPath: modelDirectory, cacheMethod: 'none' },
    { load_system_dawg: '0', load_freq_dawg: '0' });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
    return worker;
  } catch (error) {
    await worker.terminate();
    throw error;
  }
}
