// Navegación entre pantallas con pila (biblioteca > ficha > lector/cuaderno).
//
// Cada pantalla es un objeto { el, title(params), enter(params), leave() }. El router solo sabe
// mostrar/ocultar y llevar la pila; no sabe nada de libros ni de anotaciones.

export function createRouter({ views, headerTitle, backButton }) {
  const stack = []; // [{ name, params }]

  function render() {
    const top = stack[stack.length - 1];
    Object.entries(views).forEach(([name, v]) => v.el.classList.toggle('active', name === top.name));
    document.getElementById('app').classList.toggle('is-reading', top.name === 'reader');
    headerTitle.textContent = views[top.name].title(top.params);
    document.getElementById('reader-title').textContent = headerTitle.textContent;
    backButton.classList.toggle('hidden', stack.length < 2);
    views[top.name].enter(top.params);
  }

  function leaveCurrent() {
    const top = stack[stack.length - 1];
    if (top) views[top.name].leave();
  }

  return {
    /** Abre una pantalla encima de la actual. */
    go(name, params = {}) {
      leaveCurrent();
      stack.push({ name, params });
      render();
    },
    /** Vuelve a la pantalla anterior. Devuelve false si ya estaba en la raíz. */
    back() {
      if (stack.length < 2) return false;
      leaveCurrent();
      stack.pop();
      render();
      return true;
    },
    /** Vacía la pila y deja una sola pantalla (p. ej. volver a la biblioteca tras borrar un libro). */
    reset(name, params = {}) {
      leaveCurrent();
      stack.length = 0;
      stack.push({ name, params });
      render();
    },
    /** Redibuja la pantalla actual (útil cuando cambian los datos). */
    refresh() { if (stack.length) render(); },
    current: () => stack[stack.length - 1] || null
  };
}
