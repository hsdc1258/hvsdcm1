import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUTPUT = path.join(ROOT, '.learning-dist');

function browserGlobal(root, relativePath, name) {
  const sandbox = { window: {} };
  const source = readFileSync(path.join(root, relativePath), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: relativePath });
  return sandbox.window[name];
}
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export function buildLearningPayloads({ root = ROOT, outputDirectory = DEFAULT_OUTPUT } = {}) {
  const words = browserGlobal(root, '_learning/wordmaster/words.js', 'WORDMASTER_WORDS');
  const emoji = browserGlobal(root, '_learning/wordmaster/words.js', 'WORDMASTER_EMOJI');
  const data = browserGlobal(root, '_learning/smstudy/data.js', 'SMSTUDY_DATA');
  const notebook = browserGlobal(root, '_learning/smstudy/notebook-data.js', 'SMSTUDY_NOTEBOOK');
  const explanations = browserGlobal(root, '_learning/smstudy/explanation-data.js', 'SMSTUDY_EXPLANATIONS');
  const plstudy = browserGlobal(root, '_learning/plstudy/data.js', 'PLSTUDY_DATA');

  if (!Array.isArray(words) || words.length !== 2_000) throw new Error(`WordMaster 단어 수가 2,000이 아닙니다: ${words?.length}`);
  const subunits = data?.UNITS?.flatMap((unit) => unit.subs) || [];
  if (data?.UNITS?.length !== 5 || subunits.length !== 17 || data?.QUESTION_ROWS?.length !== 78 || data?.QUESTIONS?.length !== 98) {
    throw new Error('사회·문화 데이터 불변식(5단원/17중단원/98문항)이 깨졌습니다.');
  }
  if (!notebook?.NOTEBOOKS || Object.keys(notebook.NOTEBOOKS).length !== 17 || Object.keys(explanations?.GUIDES || {}).length !== 17) {
    throw new Error('사회·문화 노트 또는 해설 데이터가 불완전합니다.');
  }
  const plSubunits = plstudy?.UNITS?.flatMap((unit) => unit.subs) || [];
  if (plstudy?.UNITS?.length !== 6 || plSubunits.length !== 18 || plstudy?.QUESTIONS?.length !== 90) {
    throw new Error('정치와 법 데이터 불변식(6단원/18중단원/90문항)이 깨졌습니다.');
  }

  const imageDirectory = path.join(root, '_learning/smstudy/kice');
  const imageNames = readdirSync(imageDirectory).filter((name) => name.endsWith('.webp')).sort();
  const referenced = new Set(data.QUESTION_ROWS.map((question) => path.basename(question.image)));
  if (imageNames.length !== 78 || referenced.size !== 78 || imageNames.some((name) => !referenced.has(name))) {
    throw new Error('사회·문화 이미지 불변식(78개, 전부 참조)이 깨졌습니다.');
  }

  const wordmasterFile = path.join(outputDirectory, 'learning/wordmaster.json');
  const smstudyFile = path.join(outputDirectory, 'learning/smstudy.json');
  const plstudyFile = path.join(outputDirectory, 'learning/plstudy.json');
  writeJson(wordmasterFile, { words, emoji });
  writeJson(smstudyFile, { data, notebook, explanations });
  writeJson(plstudyFile, { data: plstudy });

  const objects = [
    ...imageNames.map((name) => ({
      key: `learning/smstudy/kice/${name}`,
      file: path.relative(root, path.join(imageDirectory, name)).replaceAll('\\', '/'),
      content_type: 'image/webp',
    })),
    {
      key: 'learning/wordmaster.json',
      file: path.relative(root, wordmasterFile).replaceAll('\\', '/'),
      content_type: 'application/json; charset=utf-8',
    },
    {
      key: 'learning/smstudy.json',
      file: path.relative(root, smstudyFile).replaceAll('\\', '/'),
      content_type: 'application/json; charset=utf-8',
    },
    {
      key: 'learning/plstudy.json',
      file: path.relative(root, plstudyFile).replaceAll('\\', '/'),
      content_type: 'application/json; charset=utf-8',
    },
  ].map((object) => {
    const absolute = path.join(root, object.file);
    if (!existsSync(absolute)) throw new Error(`학습 payload 파일이 없습니다: ${object.file}`);
    return { ...object, bytes: statSync(absolute).size, sha256: sha256(absolute) };
  });

  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    counts: { words: words.length, subunits: subunits.length, questions: data.QUESTIONS.length, images: imageNames.length, pl_subunits: plSubunits.length, pl_questions: plstudy.QUESTIONS.length },
    objects,
  };
  writeJson(path.join(outputDirectory, 'learning-manifest.json'), manifest);
  return manifest;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const manifest = buildLearningPayloads();
    console.log(`Learning R2 readiness PASS: ${manifest.counts.words} words / ${manifest.counts.questions} questions / ${manifest.counts.images} images / ${manifest.objects.length} objects`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
