import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExtractPrompt, parseModelJson, normalizeExtraction, mergeFields, emptyFields,
  validateFields, nextQuestion, normalizePhone, isYes, isNo, isCancel, csvLine, formatSummary,
} from './application.js';

// Понедельник, 23.11.2026, 12:00 по Астане (UTC+5).
const NOW = Date.UTC(2026, 10, 23, 7, 0);
const ok = { date: '2026-11-27', time: '19:00', guests: 4, name: 'Аскар', phone: '87011234567' };

test('в промпт подставляется сегодняшняя дата из кода', () => {
  const p = buildExtractPrompt('Сегодня {{TODAY}} ({{WEEKDAY}})', NOW);
  assert.equal(p, 'Сегодня 2026-11-23 (понедельник)');
});

test('parseModelJson: чистый JSON и обёртка ```json принимаются, текст вокруг нет', () => {
  assert.deepEqual(parseModelJson('{"intent":"booking"}'), { intent: 'booking' });
  assert.deepEqual(parseModelJson('```json\n{"intent":"other"}\n```'), { intent: 'other' });
  assert.equal(parseModelJson('Вот JSON: {"intent":"booking"}'), null);
  assert.equal(parseModelJson('[1,2]'), null);
  assert.equal(parseModelJson(''), null);
});

test('normalizeExtraction: поля приводятся к типам, мусор отбрасывается', () => {
  const r = normalizeExtraction({ intent: 'booking', date: '2026-11-27', guests: '4', name: ' ', phone: 87011234567, missing: ['name', 'xxx'] });
  assert.equal(r.intent, 'booking');
  assert.equal(r.fields.guests, 4);
  assert.equal(r.fields.name, null);
  assert.equal(r.fields.phone, '87011234567');
  assert.deepEqual(r.missing, ['name']);
  assert.equal(normalizeExtraction({ date: 'x' }), null);
});

test('mergeFields: новые значения перекрывают старые, null ничего не стирает', () => {
  const m = mergeFields({ ...emptyFields(), date: '2026-11-27', guests: 2 }, { ...emptyFields(), guests: 5, time: '20:00' });
  assert.deepEqual(m, { date: '2026-11-27', time: '20:00', guests: 5, name: null, phone: null });
});

test('validateFields: корректная заявка проходит, телефон нормализуется', () => {
  const r = validateFields(ok, NOW);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.missing, []);
  assert.equal(r.fields.phone, '+77011234567');
  assert.equal(nextQuestion(r), null);
});

test('validateFields: дата в прошлом', () => {
  const r = validateFields({ ...ok, date: '2026-11-20' }, NOW);
  assert.equal(r.errors[0].field, 'date');
  assert.equal(r.fields.date, null);
  assert.deepEqual(r.missing, ['date']);
});

test('validateFields: время в часах работы (пт до 23:00 включительно, вс с 11:00)', () => {
  assert.equal(validateFields({ ...ok, date: '2026-11-27', time: '23:00' }, NOW).errors.length, 0);
  assert.equal(validateFields({ ...ok, date: '2026-11-27', time: '23:30' }, NOW).errors[0].field, 'time');
  assert.equal(validateFields({ ...ok, date: '2026-11-29', time: '10:30' }, NOW).errors[0].field, 'time'); // вс
  assert.equal(validateFields({ ...ok, date: '2026-11-24', time: '21:30' }, NOW).errors[0].field, 'time'); // вт, последняя бронь 21:00
  assert.equal(validateFields({ ...ok, date: '2026-11-24', time: '21:00' }, NOW).errors.length, 0);
});

test('validateFields: сегодня время уже прошло', () => {
  const r = validateFields({ ...ok, date: '2026-11-23', time: '11:00' }, NOW);
  assert.equal(r.errors[0].field, 'time');
});

test('validateFields: время проверяется, только когда известна дата', () => {
  const r = validateFields({ ...emptyFields(), time: '23:30' }, NOW);
  assert.deepEqual(r.errors, []);
  assert.equal(r.fields.time, '23:30');
});

test('validateFields: телефон и гости', () => {
  assert.equal(validateFields({ ...ok, phone: '701 123 45' }, NOW).errors[0].field, 'phone');
  assert.equal(validateFields({ ...ok, guests: 25 }, NOW).errors[0].field, 'guests');
  assert.equal(validateFields({ ...ok, guests: 0 }, NOW).errors[0].field, 'guests');
  assert.equal(normalizePhone('+7 (701) 123-45-67'), '+77011234567');
  assert.equal(normalizePhone('8 701 123 45 67'), '+77011234567');
  assert.equal(normalizePhone('12345'), null);
});

test('nextQuestion: один вопрос про первое недостающее поле', () => {
  const r = validateFields({ ...emptyFields(), date: '2026-11-27', name: 'Аскар' }, NOW);
  assert.deepEqual(r.missing, ['time', 'guests', 'phone']);
  assert.match(nextQuestion(r), /Во сколько/);
});

test('ответы на «Подтверждаете?»', () => {
  for (const t of ['да', 'Да!', 'да, всё верно', 'Подтверждаю', 'ок']) assert.equal(isYes(t), true, t);
  for (const t of ['нет', 'да, но время 20:00', 'не уверен', 'хочу меню']) assert.equal(isYes(t), false, t);
  assert.equal(isNo('нет'), true);
  assert.equal(isNo('нет, время 20:00'), false);
  assert.equal(isCancel('отмена'), true);
  assert.equal(isCancel('/cancel'), true);
});

test('formatSummary и csvLine', () => {
  const r = validateFields(ok, NOW);
  assert.match(formatSummary(r.fields), /27\.11\.2026 \(пятница\), ⏰ 19:00/);
  assert.equal(csvLine(['a', 'b,c', 'say "hi"', '=cmd', '+77011234567']), 'a,"b,c","say ""hi""",\'=cmd,+77011234567\n');
});
