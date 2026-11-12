const LETTER_DELAY_MS = 3;
const LETTER_FADE_MS = 520;
const LETTER_REASSEMBLE_MS = 420;
const REVEAL_MS = 560;

function dissolveText(root, document, win) {
  const walker = document.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue.trim()) textNodes.push(node);
    node = walker.nextNode();
  }

  let letterIndex = 0;
  const addedLabels = new Set();
  for (const textNode of textNodes) {
    const parent = textNode.parentElement;
    if (!parent.hasAttribute('aria-label')) {
      parent.setAttribute('aria-label', parent.textContent.trim());
      addedLabels.add(parent);
    }

    const letters = Array.from(textNode.nodeValue, (character) => {
      const letter = document.createElement('span');
      letter.className = 'welcome-letter';
      letter.setAttribute('aria-hidden', 'true');
      letter.style.setProperty('--letter-index', String(letterIndex));
      letter.textContent = character === ' ' ? '\u00a0' : character;
      letterIndex += 1;
      return letter;
    });
    textNode.replaceWith(...letters);
  }

  return {
    letterCount: letterIndex,
    restore() {
      root.querySelectorAll('.welcome-letter').forEach((letter) => {
        letter.replaceWith(document.createTextNode(letter.textContent.replaceAll('\u00a0', ' ')));
      });
      addedLabels.forEach((element) => element.removeAttribute('aria-label'));
    }
  };
}

export function createWelcomeScreen({ root, onComplete }) {
  const document = root.ownerDocument;
  const win = document.defaultView;
  const choices = [...root.querySelectorAll('.welcome-choice')];
  const correctChoice = root.querySelector('[data-answer="correct"]');
  const feedback = root.querySelector('.welcome-feedback');
  const reducedMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  let completed = false;
  let animating = false;
  const timers = new Set();
  const schedule = (callback, delay) => {
    const timer = win.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  };

  function choose(event) {
    const choice = event.currentTarget;
    if (completed || animating) return;

    if (choice.dataset.answer !== 'correct') {
      animating = true;
      choices.forEach((button) => { button.disabled = true; });
      const animation = dissolveText(root, document, win);
      root.classList.add('is-dissolving');
      const fadeTime = reducedMotion
        ? 0
        : (animation.letterCount - 1) * LETTER_DELAY_MS + LETTER_FADE_MS;

      schedule(() => {
        root.classList.remove('is-dissolving');
        root.classList.add('is-reassembling');
        const reassembleTime = reducedMotion
          ? 0
          : (animation.letterCount - 1) * LETTER_DELAY_MS + LETTER_REASSEMBLE_MS;
        schedule(() => {
          root.classList.remove('is-reassembling');
          animation.restore();
          feedback.textContent = '¡Ups, hechizo equivocado!';
          choices.forEach((button) => { button.disabled = false; });
          animating = false;
        }, reassembleTime);
      }, fadeTime);
      return;
    }

    completed = true;
    choices.forEach((button) => { button.disabled = true; });
    feedback.textContent = 'El mapa se abre…';
    const { letterCount } = dissolveText(root, document, win);
    root.classList.add('is-dissolving');

    const lettersFadeTime = reducedMotion
      ? 0
      : (letterCount - 1) * LETTER_DELAY_MS + LETTER_FADE_MS;

    schedule(() => {
      root.classList.add('is-revealing');
      schedule(() => {
        root.hidden = true;
        onComplete();
      }, reducedMotion ? 0 : REVEAL_MS);
    }, lettersFadeTime);
  }

  choices.forEach((button) => button.addEventListener('click', choose));
  correctChoice.focus();

  return {
    destroy() {
      choices.forEach((button) => button.removeEventListener('click', choose));
      timers.forEach((timer) => win.clearTimeout(timer));
      timers.clear();
    }
  };
}
