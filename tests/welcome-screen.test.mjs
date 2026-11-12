import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createWelcomeScreen } from '../src/ui/welcome-screen.js';

function createScreen() {
  const dom = new JSDOM(`
    <section id="welcome" role="dialog">
      <span class="welcome-brand">YK-MCHRONICLES</span>
      <span class="welcome-badge">Easter egg</span>
      <h2>¿Qué dice el mapa?</h2>
      <p class="welcome-prompt">Completa el encantamiento...</p>
      <p class="welcome-quote">Juro solemnemente que mis...</p>
      <button class="welcome-choice" data-answer="correct" aria-label="Intenciones no son buenas">Intenciones no son buenas</button>
      <button class="welcome-choice" data-answer="wrong">Secretos están a salvo</button>
      <button class="welcome-choice" data-answer="wrong">Lecturas nunca terminan</button>
      <p class="welcome-feedback" role="status"></p>
    </section>
  `);
  const root = dom.window.document.querySelector('#welcome');
  const scheduled = [];
  dom.window.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  dom.window.clearTimeout = () => {};
  const completed = [];
  const screen = createWelcomeScreen({ root, onComplete: () => completed.push(true) });
  return { dom, root, scheduled, completed, screen };
}

test('una respuesta incorrecta desvanece y rearma todos los textos antes del feedback', () => {
  const { dom, root, scheduled, completed, screen } = createScreen();
  const wrong = root.querySelector('[data-answer="wrong"]');

  wrong.click();

  assert.ok(root.classList.contains('is-dissolving'));
  assert.ok(root.querySelector('.welcome-brand .welcome-letter'));
  assert.ok(root.querySelector('h2 .welcome-letter'));
  assert.equal(wrong.disabled, true);
  assert.equal(root.querySelector('.welcome-feedback').textContent, '');
  assert.equal(scheduled.length, 1);
  assert.deepEqual(completed, []);

  scheduled.shift().callback();
  assert.ok(root.classList.contains('is-reassembling'));
  assert.equal(root.hidden, false);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(completed, []);

  scheduled.shift().callback();
  assert.equal(root.classList.contains('is-reassembling'), false);
  assert.equal(root.querySelector('.welcome-brand').textContent, 'YK-MCHRONICLES');
  assert.equal(root.querySelector('h2').textContent, '¿Qué dice el mapa?');
  assert.equal(root.querySelector('[data-answer="wrong"]').textContent, 'Secretos están a salvo');
  assert.equal(root.querySelectorAll('.welcome-letter').length, 0);
  assert.equal(root.querySelector('.welcome-feedback').textContent, '¡Ups, hechizo equivocado!');
  assert.equal(wrong.disabled, false);
  assert.equal(root.hidden, false);
  assert.equal(scheduled.length, 0);
  assert.deepEqual(completed, []);
  screen.destroy();
  dom.window.close();
});

test('todo el texto de bienvenida se desvanece antes de revelar la biblioteca', () => {
  const { dom, root, scheduled, completed, screen } = createScreen();
  const correct = root.querySelector('[data-answer="correct"]');

  correct.click();

  assert.ok(root.classList.contains('is-dissolving'));
  const textContainers = root.querySelectorAll(
    '.welcome-brand, .welcome-badge, h2, .welcome-prompt, .welcome-quote, .welcome-choice, .welcome-feedback'
  );
  const expectedLetters = [...textContainers].reduce((count, element) => {
    assert.ok(element.hasAttribute('aria-label'), 'animated text keeps an accessible label');
    return count + Array.from(element.getAttribute('aria-label')).length;
  }, 0);
  assert.equal(root.querySelectorAll('.welcome-letter').length, expectedLetters);
  assert.ok(root.querySelector('.welcome-brand .welcome-letter'));
  assert.ok(root.querySelector('h2 .welcome-letter'));
  assert.ok(root.querySelector('[data-answer="wrong"] .welcome-letter'));
  assert.equal(correct.disabled, true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, (expectedLetters - 1) * 3 + 520);
  assert.deepEqual(completed, []);

  scheduled.shift().callback();
  assert.ok(root.classList.contains('is-revealing'));
  assert.equal(root.hidden, false);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(completed, []);

  scheduled.shift().callback();
  assert.equal(root.hidden, true);
  assert.deepEqual(completed, [true]);

  screen.destroy();
  dom.window.close();
});
