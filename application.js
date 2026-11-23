// Приём заявок на бронь: чистые функции без Telegram и без сети.
// Модель достаёт поля из сообщения (JSON), а здесь код их проверяет, склеивает и сохраняет.

export const FIELDS = ['date', 'time', 'guests', 'name', 'phone'];
export const CAFE_PHONE = '+7 (700) 000-00-00';
export const MAX_GUESTS = 20;
export const CSV_HEADER = ['created_at', 'chat_id', 'name', 'phone', 'date', 'time', 'guests'];

const TZ_OFFSET_MIN = 5 * 60; // Астана: UTC+5
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

// Вопросы бота по полям (по одному за раз).
export const QUESTIONS = {
  date: 'На какую дату вас ждать, дорогуша? Например: «в субботу» или «28 ноября» 📅',
  time: 'Во сколько придёте? ⏰',
  guests: 'Сколько вас будет гостей? 👥',
  name: 'Как вас записать, милый? 🪄',
  phone: 'Оставьте номер телефона, администратор подтвердит бронь 📞',
};

// График из system_prompt.md: [открытие, закрытие] в минутах от полуночи.
// Бронь возможна не позже чем за 1 час до закрытия.
const HOURS = {
  1: [600, 1320], 2: [600, 1320], 3: [600, 1320], 4: [600, 1320], // пн–чт 10:00–22:00
  5: [600, 1440], 6: [600, 1440], // пт–сб 10:00–00:00
  0: [660, 1320], // вс 11:00–22:00
};

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

// «Сейчас» по Астане, как UTC-поля сдвинутой даты.
function astana(nowMs) {
  const d = new Date(nowMs + TZ_OFFSET_MIN * 60_000);
  return {
    iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    weekday: WEEKDAYS[d.getUTCDay()],
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

export function todayIso(nowMs = Date.now()) {
  return astana(nowMs).iso;
}

// Подставляет в промпт разбора сегодняшнюю дату из кода (модель её не знает).
export function buildExtractPrompt(template, nowMs = Date.now()) {
  const now = astana(nowMs);
  return template.replaceAll('{{TODAY}}', now.iso).replaceAll('{{WEEKDAY}}', now.weekday);
}

// Разбирает ответ модели. Допускаем только обёртку ```json … ```, любой другой текст = неудача.
export function parseModelJson(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

const str = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

// Приводит ответ модели к виду { intent, fields, missing }. Не JSON-объект с intent = null.
export function normalizeExtraction(obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.intent !== 'string') return null;
  let guests = obj.guests;
  if (typeof guests === 'string' && /^\d+$/.test(guests.trim())) guests = Number(guests.trim());
  return {
    intent: obj.intent === 'booking' ? 'booking' : 'other',
    fields: {
      date: str(obj.date),
      time: str(obj.time),
      guests: typeof guests === 'number' ? guests : null,
      name: str(obj.name),
      phone: str(obj.phone),
    },
    missing: Array.isArray(obj.missing) ? obj.missing.filter((f) => FIELDS.includes(f)) : [],
  };
}

export function emptyFields() {
  return { date: null, time: null, guests: null, name: null, phone: null };
}

// Новые значения перекрывают старые, null ничего не стирает.
export function mergeFields(prev, incoming) {
  const out = { ...prev };
  for (const f of FIELDS) if (incoming[f] !== null && incoming[f] !== undefined) out[f] = incoming[f];
  return out;
}

function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return { weekdayIndex: date.getUTCDay() };
}

function parseTime(s) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { text: `${pad(Number(m[1]))}:${m[2]}`, minutes: Number(m[1]) * 60 + Number(m[2]) };
}

export function normalizePhone(s) {
  const digits = String(s ?? '').replace(/\D/g, '');
  if (digits.length !== 11) return null;
  return `+${digits.startsWith('8') ? `7${digits.slice(1)}` : digits}`;
}

// Проверяет поля. Некорректное значение сбрасывается в null и попадает в errors
// вместе с готовой фразой для гостя. missing = какие поля ещё пусты.
export function validateFields(fields, nowMs = Date.now()) {
  const f = { ...fields };
  const errors = [];
  const bad = (field, message) => {
    f[field] = null;
    errors.push({ field, message });
  };
  const now = astana(nowMs);
  let dayInfo = null;

  if (f.date !== null) {
    dayInfo = parseIsoDate(f.date);
    if (!dayInfo) {
      bad('date', 'Не разобрала дату, дорогуша. Напишите её ещё раз, например «28 ноября» 📅');
      dayInfo = null;
    } else if (f.date < now.iso) {
      bad('date', 'Эта дата уже прошла: совы пока не летают в прошлое 🦉 На какое число записать?');
      dayInfo = null;
    }
  }

  let time = null;
  if (f.time !== null) {
    time = parseTime(f.time);
    if (!time) bad('time', 'Не разобрала время. Напишите его ещё раз, например «19:00» ⏰');
    else f.time = time.text;
  }

  if (dayInfo && time) {
    const [open, close] = HOURS[dayInfo.weekdayIndex];
    const last = close - 60;
    if (time.minutes < open || time.minutes > last) {
      bad(
        'time',
        `В этот день мы открыты с ${hhmm(open)} до ${hhmm(close)}, бронь принимаем до ${hhmm(last)}. Во сколько вам удобно? ⏰`,
      );
    } else if (f.date === now.iso && time.minutes <= now.minutes) {
      bad('time', 'Это время уже прошло, дорогуша. Выберите другое ⏰');
    }
  }

  if (f.guests !== null) {
    if (!Number.isInteger(f.guests) || f.guests < 1) {
      bad('guests', 'Не поняла, сколько вас. Назовите число гостей 👥');
    } else if (f.guests > MAX_GUESTS) {
      bad('guests', `Для компаний больше ${MAX_GUESTS} человек позвоните нам: ${CAFE_PHONE} 📞 Или назовите другое число гостей.`);
    }
  }

  if (f.name !== null && f.name.length > 50) bad('name', 'Имя слишком длинное. Как вас записать? 🪄');

  if (f.phone !== null) {
    const phone = normalizePhone(f.phone);
    if (!phone) bad('phone', 'В номере должно быть 11 цифр, например 8 701 123 45 67. Напишите ещё раз 📞');
    else f.phone = phone;
  }

  return { fields: f, errors, missing: FIELDS.filter((k) => f[k] === null) };
}

// Один вопрос гостю: сначала ошибка проверки, иначе первое недостающее поле.
export function nextQuestion(result) {
  if (result.errors.length) return result.errors[0].message;
  if (result.missing.length) return QUESTIONS[result.missing[0]];
  return null;
}

export function hallFor(guests) {
  return guests > 6 ? 'Зал факультетов' : 'У камина';
}

export function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function formatSummary(f) {
  const weekday = WEEKDAYS[parseIsoDate(f.date).weekdayIndex];
  return [
    `📅 ${formatDate(f.date)} (${weekday}), ⏰ ${f.time}`,
    `👥 Гостей: ${f.guests}`,
    `👤 ${f.name}`,
    `📞 ${f.phone}`,
  ].join('\n');
}

// Короткие ответы гостя на «Подтверждаете?».
export function isYes(text) {
  const t = text.trim().toLowerCase();
  if (t.length > 30 || /\d/.test(t) || /(^|[^а-яё])(нет|не|измен|поправ|испра)/.test(t)) return false;
  return /(^|[^а-яё])(да|верно|подтвержда|ага|угу|ок|окей|конечно)/.test(t) || /^yes\b/.test(t);
}

export function isNo(text) {
  const t = text.trim().toLowerCase();
  return t.length <= 20 && !/\d/.test(t) && /^(нет|не так|неверно|не верно|изменить|поправить|исправить)/.test(t);
}

export function isCancel(text) {
  return /^\s*(\/cancel|отмена|отменить|не надо|не нужно|передумал[аи]?|стоп)[\s.!]*$/i.test(text);
}

// Строка CSV. Имя защищено от формул Excel (=, +, -, @ в начале).
export function csvLine(values) {
  return values
    .map((v) => {
      let s = String(v ?? '');
      if (/^[=+\-@]/.test(s) && !/^\+\d+$/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    })
    .join(',') + '\n';
}
