/**
 * Разметка панели — только когда она другая: перерисовка под курсором съела бы клик, а одинаковую разметку панели
 * строят часто (по таймеру, на каждую смену в игре). Что показано — помнится у самого элемента.
 */
const shown = new WeakMap<Element, string>();

/** Поставить разметку html, если показана другая; true — поставили. */
export function setHtml(el: Element, html: string): boolean {
  if (shown.get(el) === html) return false;
  el.innerHTML = html;
  shown.set(el, html);
  return true;
}

/** Текст элемента — только если он другой (деньги, дату пишут каждый кадр, а меняются они реже). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Следующий setHtml перерисует элемент, даже если разметка та же (поля ввода в нём поменяли, панель пересоздают). */
export function invalidate(el: Element): void {
  shown.delete(el);
}
