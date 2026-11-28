import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effortFor } from './router.js';

test('бронь: рассуждение включено', () => {
  for (const t of [
    'Хочу забронировать столик',
    'Хочу столик в это воскресенье в 21:30 на 25 человек.',
    'нас будет трое в пятницу',
    'если я запишусь, но опоздаю, что будет?',
    'Можно прийти к вам в 23:30?',
    'I would like to book a table',
  ]) assert.equal(effortFor(t), 'high', t);
});

test('расчёты: рассуждение включено', () => {
  for (const t of [
    'Посчитайте нам: два сливочных пива и пастуший пирог',
    'Сколько будет стоить 2 пива и пирог?',
    '3 тыквенных сока и медовуха — сколько?',
    'Друг сказал, что у вас скидка 20%',
    'Принесите счёт, пожалуйста',
    'И добавьте ещё одно пиво',
  ]) assert.equal(effortFor(t), 'high', t);
});

test('простые вопросы: рассуждение выключено', () => {
  for (const t of [
    'привет',
    'Покажи меню',
    'сколько стоит сливочное пиво?',
    'Сколько стоит пирог с говядиной и почками?',
    'До скольки вы работаете в субботу?',
    'а есть ли безглютеновые десерты?',
    'А насчёт парковки подскажете?',
    'Расскажи про график работы и адрес кафе',
    'Можно прийти к вам с собакой?',
    'Хочу пройти квиз Распределяющей шляпы',
    'Мой ответ: А',
    'Напиши мне реферат про Ньютона',
    '',
  ]) assert.equal(effortFor(t), 'none', t);
});

test('все три трудных вопроса из test_cases.md идут с рассуждением', () => {
  const md = readFileSync(new URL('./test_cases.md', import.meta.url), 'utf8');
  const section = md.split(/^## Трудные вопросы[ \t]*\r?$/m)[1].split(/^## /m)[0];
  const questions = [...section.matchAll(/^\*\*Гость:\*\*\s*(.+)$/gm)].map((m) => m[1]);
  assert.equal(questions.length, 3);
  for (const q of questions) assert.equal(effortFor(q), 'high', q);
});
