// Сравнение ответов одной модели с выключенным и включённым рассуждением.
// Берёт system_prompt.md и «Трудные вопросы» из test_cases.md, пишет comparison.md.
// Бота (index.js) не использует и не меняет.
//
// Проверка без запросов:  node --env-file=.env compare.js --dry-run
// Запуск (6 запросов):    node --env-file=.env compare.js
// Готовый отчёт не перезаписывается без флага --force.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(DIR, 'comparison.md');
const OR_KEY = process.env.OPENROUTER_API_KEY || process.env.API_KEY;

const MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const EFFORTS = ['none', 'high'];
const TEMPERATURE = 0.6; // как у бота
const MAX_TOKENS = 8000; // рассуждение тоже расходует этот лимит
const TIMEOUT_MS = 300_000;
const TZ_NAME = 'Asia/Almaty';

const read = (name) => readFileSync(path.join(DIR, name), 'utf8').replace(/\r\n/g, '\n');

// Реплики «Гость:» из раздела «Трудные вопросы». Ожидаемые ответы в модель не попадают.
function loadQuestions() {
  const section = read('test_cases.md').split(/^## Трудные вопросы[ \t]*$/m)[1]?.split(/^## /m)[0];
  if (!section) throw new Error('в test_cases.md нет раздела «Трудные вопросы»');
  const questions = section
    .split(/^### /m)
    .slice(1)
    .map((block) => ({
      title: block.split('\n')[0].replace(/^\d+\.\s*/, '').trim(),
      text: /^\*\*Гость:\*\*\s*(.+)$/m.exec(block)?.[1].trim(),
    }));
  if (questions.length !== 3 || questions.some((q) => !q.text)) {
    throw new Error(`ожидалось 3 вопроса с репликой «Гость:», найдено блоков: ${questions.length}`);
  }
  return questions;
}

// Так же, как в боте: system prompt + текущие дата и время Астаны.
function buildSystemPrompt(now) {
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ_NAME, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ_NAME, hour: '2-digit', minute: '2-digit',
  }).format(now);
  const text = `${read('system_prompt.md').trim()}\n\n## ТЕКУЩЕЕ ВРЕМЯ (служебная информация)\nСейчас в Астане: ${date}, ${time}. Используй это, чтобы проверять даты брони и понимать «сегодня», «завтра», «в субботу».`;
  return { text, stamp: `${date}, ${time}` };
}

// Один запрос, без повторов: ошибка тоже результат и попадает в отчёт.
async function ask(system, question, effort) {
  const started = performance.now();
  const seconds = () => (performance.now() - started) / 1000;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: question },
        ],
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        reasoning: { effort },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    const choice = data?.choices?.[0];
    const apiError = data?.error ?? choice?.error;
    if (!res.ok || apiError || !choice) {
      return { seconds: seconds(), error: `HTTP ${res.status}: ${apiError?.message ?? 'нет ответа модели'}` };
    }
    return {
      seconds: seconds(),
      answer: choice.message?.content?.trim() ?? '',
      reasoning: choice.message?.reasoning?.trim() ?? '',
      usage: data.usage,
      finish: choice.finish_reason,
    };
  } catch (err) {
    return { seconds: seconds(), error: err.message };
  }
}

const cell = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\|/g, '\\|').replace(/\n/g, '<br>');

// Блок кода, который не сломают обратные кавычки внутри текста.
function fenced(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((s) => s.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function report(runs, stamp) {
  const rows = runs.map((r) => {
    const u = r.usage ?? {};
    let answer = r.error ? `ОШИБКА: ${r.error}` : r.answer || '(пустой ответ)';
    if (r.finish && r.finish !== 'stop') answer += `\n[finish_reason: ${r.finish}]`;
    return `| ${[
      r.n,
      `${r.q}. ${cell(r.title)}`,
      r.effort,
      r.seconds.toFixed(1),
      u.prompt_tokens ?? '—',
      u.completion_tokens ?? '—',
      u.completion_tokens_details?.reasoning_tokens ?? '—',
      u.total_tokens ?? '—',
      cell(answer),
      r.reasoning ? `[${r.reasoning.length} симв.](#run-${r.n})` : 'нет',
    ].join(' | ')} |`;
  });

  const details = runs.map((r) =>
    [
      `<a id="run-${r.n}"></a>`,
      `### Запуск ${r.n}: вопрос ${r.q}, effort «${r.effort}»`,
      '',
      r.reasoning ? fenced(r.reasoning) : 'Поле `message.reasoning` пустое.',
    ].join('\n'),
  );

  return [
    '# Сравнение: рассуждение выключено и включено',
    '',
    `- Модель: \`${MODEL}\``,
    `- Настройки: temperature ${TEMPERATURE}, max_tokens ${MAX_TOKENS}, \`reasoning.effort\`: ${EFFORTS.join(' / ')}`,
    `- Дата в system prompt: ${stamp} (Астана)`,
    `- Запросов выполнено: ${runs.length}, без повторов`,
    '',
    '## Вопросы',
    '',
    ...[...new Map(runs.map((r) => [r.q, r])).values()].map((r) => `${r.q}. **${r.title}.** ${r.question}`),
    '',
    '## Таблица',
    '',
    '| № | Вопрос | effort | Время, с | Токены: вход | выход | из них рассуждение | всего | Ответ | Рассуждение |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Тексты рассуждений (`message.reasoning`)',
    '',
    details.join('\n\n'),
    '',
  ].join('\n');
}

const questions = loadQuestions();
const { text: system, stamp } = buildSystemPrompt(new Date());

if (process.argv.includes('--dry-run')) {
  console.log(`Модель: ${MODEL}; effort: ${EFFORTS.join(', ')}; дата: ${stamp}`);
  console.log(`System prompt: ${system.length} симв.; ключ найден: ${OR_KEY ? 'да' : 'нет'}`);
  questions.forEach((q, i) => console.log(`${i + 1}. ${q.title}: ${q.text}`));
  console.log(`Запросов будет: ${questions.length * EFFORTS.length}`);
} else {
  if (existsSync(OUT_FILE) && !process.argv.includes('--force')) {
    console.error('comparison.md уже есть. Чтобы запустить заново и перезаписать его, добавьте --force');
    process.exit(1);
  }
  if (!OR_KEY) {
    console.error('Нужен API_KEY (или OPENROUTER_API_KEY) в .env');
    process.exit(1);
  }
  const runs = [];
  for (const [i, q] of questions.entries()) {
    for (const effort of EFFORTS) {
      const result = await ask(system, q.text, effort);
      const run = { n: runs.length + 1, q: i + 1, title: q.title, question: q.text, effort, ...result };
      runs.push(run);
      // Пишем после каждого запроса, чтобы не потерять результаты при сбое.
      writeFileSync(OUT_FILE, report(runs, stamp), 'utf8');
      console.log(`[${run.n}/6] вопрос ${run.q}, effort ${effort}: ${run.seconds.toFixed(1)} с, ${run.error ?? 'ок'}`);
    }
  }
  console.log(`Готово: ${OUT_FILE}`);
}
