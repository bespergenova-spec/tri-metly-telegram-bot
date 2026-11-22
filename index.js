// Telegram-бот «Три метлы» (мадам Розмерта) на Node.js.
// Модель OpenRouter + system prompt из system_prompt.md.
// Программная часть: брони ([BOOKING] -> bookings.json), напоминания, /bookings, /myid.
// Без внешних зависимостей, нужен Node.js >= 20.6 (запуск: npm start).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OR_KEY = process.env.OPENROUTER_API_KEY || process.env.API_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;

if (!TG_TOKEN || !OR_KEY) {
  console.error('Нужны TELEGRAM_BOT_TOKEN и API_KEY (или OPENROUTER_API_KEY) в .env');
  process.exit(1);
}

const PROMPT_FILE = path.resolve(DIR, process.env.SYSTEM_PROMPT_FILE || 'system_prompt.md');
const SYSTEM_PROMPT = readFileSync(PROMPT_FILE, 'utf8').trim();

const CAFE_PHONE = '+7 (700) 000-00-00';
const TZ_OFFSET_H = 5; // Астана: UTC+5
const TZ_NAME = 'Asia/Almaty';

// Порядок важен: при ошибке (например, 429) пробуем следующую модель.
const MODELS = (process.env.MODELS ||
  [
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3.5-super-vl:free',
  ].join(',')
).split(',').map((s) => s.trim()).filter(Boolean);

// Модели, которые умеют смотреть картинки.
const VISION_MODELS = (process.env.VISION_MODELS ||
  [
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3.5-super-vl:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  ].join(',')
).split(',').map((s) => s.trim()).filter(Boolean);

const TEMPERATURE = Number(process.env.TEMPERATURE ?? 0.6);
const MAX_HISTORY = 30; // квиз и бронь — длинные диалоги, нужен запас
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

const histories = new Map(); // chatId -> [{role, content}]
const busy = new Set(); // чаты, где уже идёт генерация
const lastQuiz = new Map(); // chatId -> message_id вопроса квиза с активными кнопками

// ---------- Кнопки ----------

// Постоянная клавиатура под полем ввода. Нажатие = обычное сообщение с надписью кнопки.
const MAIN_KEYBOARD = {
  keyboard: [
    ['🍺 Меню', '📅 Забронировать столик'],
    ['🕐 График и адрес', '🎩 Шляпа'],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

// Что на самом деле «говорит» гость, когда нажимает кнопку.
const BUTTON_REQUESTS = {
  '🍺 Меню': 'Покажи меню',
  '📅 Забронировать столик': 'Хочу забронировать столик',
  '🕐 График и адрес': 'Расскажи про график работы и адрес кафе',
  '🎩 Шляпа': 'Хочу пройти квиз Распределяющей шляпы',
};

// Кнопки ответов квиза (под сообщением).
const QUIZ_KEYBOARD = {
  inline_keyboard: [
    ['А', 'Б', 'В', 'Г'].map((l) => ({ text: l, callback_data: `quiz:${l}` })),
  ],
};

// Вопрос квиза = в ответе есть все четыре варианта «А) … Б) … В) … Г) …».
function isQuizQuestion(text) {
  return ['А', 'Б', 'В', 'Г'].every((l) => new RegExp(`(^|[\\s*_])${l}[).]\\s*\\S`, 'm').test(text));
}

// ---------- Брони ----------

const BOOKINGS_FILE = path.join(DIR, 'bookings.json');

function loadBookings() {
  try {
    return existsSync(BOOKINGS_FILE) ? JSON.parse(readFileSync(BOOKINGS_FILE, 'utf8')) : [];
  } catch (err) {
    console.error('Не удалось прочитать bookings.json:', err.message);
    return [];
  }
}

const bookings = loadBookings();

function saveBookings() {
  writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2), 'utf8');
}

// "ДД.ММ.ГГГГ" + "ЧЧ:ММ" (время Астаны) -> миллисекунды UTC
function visitUtc(date, time) {
  const d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(date ?? '');
  const t = /^(\d{1,2}):(\d{2})$/.exec(time ?? '');
  if (!d || !t) return null;
  return Date.UTC(+d[3], +d[2] - 1, +d[1], +t[1] - TZ_OFFSET_H, +t[2]);
}

// Напоминание: накануне визита в 12:00 по Астане.
function reminderUtc(date) {
  const d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(date);
  return Date.UTC(+d[3], +d[2] - 1, +d[1] - 1, 12 - TZ_OFFSET_H, 0);
}

// Сообщения уходят как простой текст, поэтому markdown-разметка показывалась бы звёздочками.
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[*-][ \t]+/gm, '• ');
}

function extractBooking(answer) {
  const m = /\[BOOKING\]([\s\S]*?)\[\/BOOKING\]/.exec(answer);
  if (!m) return { text: answer, booking: null };
  const text = answer.replace(/\[BOOKING\][\s\S]*?\[\/BOOKING\]/g, '').trim();
  try {
    return { text, booking: JSON.parse(m[1].trim()) };
  } catch {
    console.warn('[booking] не удалось разобрать JSON:', m[1].trim().slice(0, 200));
    return { text, booking: null };
  }
}

function validateBooking(b) {
  if (!b || typeof b !== 'object') return 'нет данных';
  for (const k of ['name', 'date', 'time', 'phone']) {
    if (!b[k] || typeof b[k] !== 'string') return `нет поля ${k}`;
  }
  if (!Number.isInteger(b.guests) || b.guests < 1) return 'некорректное число гостей';
  const at = visitUtc(b.date, b.time);
  if (at === null) return 'некорректные дата или время';
  if (at < Date.now()) return 'дата в прошлом';
  return null;
}

function formatBooking(b, i) {
  const parts = [
    `${i + 1}. ${b.date} ${b.time} — ${b.name}, гостей: ${b.guests}`,
    `   зал: ${b.hall || '—'}, тел.: ${b.phone}`,
  ];
  if (b.house) parts.push(`   факультет: ${b.house}`);
  if (b.comment) parts.push(`   пожелания: ${b.comment}`);
  return parts.join('\n');
}

// ---------- Telegram ----------

async function tg(method, body = {}) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

// Telegram принимает до 4096 символов в сообщении.
function chunk(text, size = 4000) {
  const parts = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

// Последнее сообщение несёт клавиатуру: inline-кнопки, если переданы, иначе постоянную.
// Возвращает последнее отправленное сообщение.
async function say(chatId, text, inlineMarkup) {
  const parts = chunk(text);
  let sent;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    sent = await tg('sendMessage', {
      chat_id: chatId,
      text: parts[i],
      ...(isLast ? { reply_markup: inlineMarkup ?? MAIN_KEYBOARD } : {}),
    });
  }
  return sent;
}

// Убирает кнопки у старого вопроса квиза, чтобы на них нельзя было нажать повторно.
async function clearQuizButtons(chatId) {
  const messageId = lastQuiz.get(chatId);
  if (!messageId) return;
  lastQuiz.delete(chatId);
  await tg('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

async function handleCallback(q) {
  const answer = (extra = {}) =>
    tg('answerCallbackQuery', { callback_query_id: q.id, ...extra }).catch(() => {});
  const chatId = q.message?.chat.id;
  const data = q.data ?? '';
  if (!chatId || !data.startsWith('quiz:')) return answer();

  const letter = data.slice('quiz:'.length);
  const messageId = q.message.message_id;

  if (lastQuiz.get(chatId) !== messageId) {
    // Старый вопрос: ответ на него уже не нужен.
    await answer({ text: 'Этот вопрос уже позади, дорогуша 🎩' });
    await tg('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
    return;
  }
  if (busy.has(chatId)) return answer({ text: 'Минуточку, я ещё отвечаю…' });

  lastQuiz.delete(chatId);
  await answer();
  await tg('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [[{ text: `✅ Ваш ответ: ${letter}`, callback_data: 'noop' }]] },
  }).catch(() => {});
  await handleMessage({ chat: q.message.chat, text: `Мой ответ: ${letter}` });
}

// Скачивает картинку из сообщения (фото или файл-картинка) и возвращает data URL.
async function getImageDataUrl(msg) {
  let fileId;
  let mime = 'image/jpeg';
  if (msg.photo?.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id; // самый большой размер
  } else if (msg.document?.mime_type?.startsWith('image/')) {
    fileId = msg.document.file_id;
    mime = msg.document.mime_type;
  } else {
    return null;
  }
  const file = await tg('getFile', { file_id: fileId });
  if (file.file_size && file.file_size > MAX_IMAGE_BYTES) throw new Error('слишком большая картинка');
  const res = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`скачивание картинки: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('слишком большая картинка');
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// ---------- OpenRouter ----------

async function askModel(model, messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OR_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: TEMPERATURE }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('пустой ответ');
  return text;
}

async function askWithFallback(messages, models = MODELS) {
  for (const model of models) {
    try {
      const text = await askModel(model, messages);
      console.log(`[ok] ${model}`);
      return text;
    } catch (err) {
      console.warn(`[fail] ${model}: ${err.message}`);
    }
  }
  throw new Error('все модели недоступны');
}

// System prompt + текущая дата: без неё модель не проверит «дата не в прошлом».
function buildSystemPrompt() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ_NAME, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ_NAME, hour: '2-digit', minute: '2-digit',
  }).format(now);
  return `${SYSTEM_PROMPT}\n\n## ТЕКУЩЕЕ ВРЕМЯ (служебная информация)\nСейчас в Астане: ${date}, ${time}. Используй это, чтобы проверять даты брони и понимать «сегодня», «завтра», «в субботу».`;
}

// ---------- Обработка сообщений ----------

const GREETING =
  'Ох, заходите, заходите, не стойте на сквозняке! 🧹 Я мадам Розмерта, хозяйка «Трёх мётел». ' +
  'Могу показать меню, рассказать, когда мы открыты, или забронировать вам столик у камина. ' +
  'А ещё Распределяющая шляпа ждёт вас: напишите /hat, и узнаем ваш факультет 🎩\n\nС чего начнём, дорогуша?';

async function handleCommand(chatId, cmd) {
  switch (cmd) {
    case '/start':
      histories.delete(chatId);
      await clearQuizButtons(chatId);
      await say(chatId, GREETING);
      return true;
    case '/reset':
      histories.delete(chatId);
      await clearQuizButtons(chatId);
      await say(chatId, 'Забыла всё, что мы говорили, дорогуша. Начнём с чистого пергамента? 📜');
      return true;
    case '/myid':
      await say(chatId, `Ваш chat id: ${chatId}`);
      return true;
    case '/bookings':
      if (ADMIN_CHAT_ID && chatId === ADMIN_CHAT_ID) {
        const upcoming = bookings.filter((b) => visitUtc(b.date, b.time) >= Date.now());
        await say(
          chatId,
          upcoming.length
            ? `📖 Ближайшие брони (${upcoming.length}):\n\n${upcoming.map(formatBooking).join('\n\n')}`
            : '📖 Ближайших броней нет.',
        );
      } else {
        await say(chatId, 'Эта книга записей только для хозяйки, дорогуша 📖 А вот помочь с бронью я могу!');
      }
      return true;
    default:
      return false;
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  let text = (msg.text ?? msg.caption)?.trim();
  const hasImage = Boolean(msg.photo?.length || msg.document?.mime_type?.startsWith('image/'));
  if (!text && !hasImage) {
    await say(chatId, 'Я понимаю текст и картинки, дорогуша.');
    return;
  }

  if (text?.startsWith('/')) {
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    if (await handleCommand(chatId, cmd)) return;
    if (cmd === '/hat') text = 'Хочу пройти квиз Распределяющей шляпы';
  } else if (text && BUTTON_REQUESTS[text]) {
    text = BUTTON_REQUESTS[text]; // нажата кнопка постоянной клавиатуры
  }

  if (busy.has(chatId)) return; // не копим очередь, пока идёт ответ
  busy.add(chatId);
  const typing = setInterval(
    () => tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}),
    4000,
  );
  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  try {
    const history = histories.get(chatId) ?? [];
    let userContent = text;
    let models = MODELS;
    let historyText = text;

    if (hasImage) {
      let dataUrl;
      try {
        dataUrl = await getImageDataUrl(msg);
      } catch (err) {
        console.warn(`[image] ${err.message}`);
        await say(chatId, 'Не получилось получить картинку. Пришлите ещё раз (до 8 МБ).');
        return;
      }
      userContent = [
        { type: 'text', text: text || 'Опиши, что изображено на картинке.' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ];
      models = VISION_MODELS;
      // В историю кладём только текст, чтобы не раздувать контекст base64-картинками.
      historyText = `[гость прислал картинку] ${text ?? ''}`.trim();
    }

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      ...history,
      { role: 'user', content: userContent },
    ];
    history.push({ role: 'user', content: historyText });

    let answer;
    try {
      answer = await askWithFallback(messages, models);
    } catch {
      history.pop(); // неудачный запрос не сохраняем
      histories.set(chatId, history);
      await say(chatId, 'Ох, дорогуша, камин сегодня барахлит — совы не долетают. Попробуйте ещё раз через минутку 🦉');
      return;
    }

    // В историю — ответ целиком (с блоком), чтобы модель помнила, что бронь оформлена.
    history.push({ role: 'assistant', content: answer });
    histories.set(chatId, history.slice(-MAX_HISTORY));

    const { text: rawVisible, booking } = extractBooking(answer);
    const visible = stripMarkdown(rawVisible);
    if (booking) await registerBooking(chatId, booking);
    // Любой новый ответ делает прошлые кнопки квиза неактуальными.
    await clearQuizButtons(chatId);
    const isQuiz = isQuizQuestion(visible);
    const sent = await say(chatId, visible || 'Минуточку, дорогуша…', isQuiz ? QUIZ_KEYBOARD : undefined);
    if (isQuiz && sent) lastQuiz.set(chatId, sent.message_id);
  } finally {
    clearInterval(typing);
    busy.delete(chatId);
  }
}

async function registerBooking(chatId, b) {
  const problem = validateBooking(b);
  if (problem) {
    console.warn(`[booking] отклонена: ${problem}`, b);
    return;
  }
  const record = {
    id: Date.now(),
    chatId,
    name: b.name,
    date: b.date,
    time: b.time,
    guests: b.guests,
    phone: b.phone,
    hall: b.hall || '',
    house: b.house || '',
    comment: b.comment || '',
    createdAt: new Date().toISOString(),
    // Если до напоминания уже меньше суток, не шлём его задним числом.
    reminded: Date.now() >= reminderUtc(b.date),
  };
  bookings.push(record);
  saveBookings();
  console.log(`[booking] сохранена: ${record.date} ${record.time}, ${record.name}, ${record.guests} гост.`);

  if (ADMIN_CHAT_ID) {
    await say(ADMIN_CHAT_ID, `🆕 Новая бронь\n\n${formatBooking(record, bookings.length - 1)}`).catch((err) =>
      console.warn('[booking] не удалось уведомить администратора:', err.message),
    );
  }
}

// ---------- Напоминания ----------

async function sendReminders() {
  const now = Date.now();
  let changed = false;
  for (const b of bookings) {
    if (b.reminded) continue;
    const at = visitUtc(b.date, b.time);
    if (at === null || at < now) {
      b.reminded = true; // визит прошёл
      changed = true;
      continue;
    }
    if (now < reminderUtc(b.date)) continue;
    try {
      await say(
        b.chatId,
        `🦉 Сова из «Трёх мётел» с весточкой!\n\nДорогуша ${b.name}, завтра в ${b.time} вас ждёт столик ` +
          `(гостей: ${b.guests}${b.hall ? `, зал «${b.hall}»` : ''}).\n` +
          `Если планы изменились, дайте знать по телефону ${CAFE_PHONE}. До встречи! 🧹`,
      );
      b.reminded = true;
      changed = true;
      console.log(`[reminder] отправлено: ${b.date} ${b.time}, ${b.name}`);
    } catch (err) {
      console.warn(`[reminder] ошибка для ${b.name}: ${err.message}`);
    }
  }
  if (changed) saveBookings();
}

// ---------- Запуск ----------

async function main() {
  const me = await tg('getMe');
  console.log(`Бот @${me.username} запущен. Промпт: ${path.basename(PROMPT_FILE)} (${SYSTEM_PROMPT.length} симв.)`);
  console.log(`Модели: ${MODELS.join(', ')}`);
  console.log(`Админ: ${ADMIN_CHAT_ID ?? 'не задан (ADMIN_CHAT_ID)'}; броней в файле: ${bookings.length}`);
  await tg('deleteWebhook'); // long polling не работает при установленном webhook

  setInterval(() => sendReminders().catch((e) => console.error('reminders:', e.message)), 60_000);

  let offset = 0;
  while (true) {
    try {
      const updates = await tg('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          handleMessage(update.message).catch((err) =>
            console.error('Ошибка обработки:', err.message),
          );
        } else if (update.callback_query) {
          handleCallback(update.callback_query).catch((err) =>
            console.error('Ошибка кнопки:', err.message),
          );
        }
      }
    } catch (err) {
      console.error('Ошибка polling:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
