/**
 * Свои подсказки панелей: у элемента с data-tip при наведении — плашка с этим текстом, сразу (браузерный title
 * появляется с задержкой). Одна на всю страницу, в body и с position: fixed — её не обрезает прокрутка панели; у краёв
 * экрана она сдвигается внутрь, нет места сверху — встаёт под элементом (tipPlacement). Длинный текст переносится
 * (max-width в CSS). data-tip-end — по правому краю элемента. data-tip-keys — горячие клавиши через «|», они
 * встают после текста значками <kbd>. Для графика доходов строки оформляет showMonthTip.
 */
import { tipPlacement } from '../render/tooltipLayout';
import { showMonthTip } from './incomeChart';

const tipOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement | SVGElement>('[data-tip]') : null);

export function installTips(doc: Document = document): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'tip-float';
  el.hidden = true;
  doc.body.appendChild(el);
  let anchor: HTMLElement | SVGElement | null = null;
  let pointer = { x: -1, y: -1 };
  let frame = 0;
  /** Что сейчас на плашке: текст, клавиши и метки строк. */
  let shown = '';

  const hide = () => {
    anchor = null;
    el.hidden = true;
  };
  /**
   * Текст и место плашки — когда что-то могло их сменить: курсор сдвинулся, панель прокрутили или перерисовали под
   * курсором (элемента подсказки уже нет, у него новый текст или место), — не чаще кадра и не каждый кадр.
   */
  const update = () => {
    frame = 0;
    if (!anchor) return;
    // Панель перерисовали (старого элемента уже нет) — подсказка того, что теперь под курсором.
    if (!anchor.isConnected) anchor = tipOf(doc.elementFromPoint(pointer.x, pointer.y));
    const text = anchor?.dataset.tip;
    if (!anchor || !text) return hide();
    const keys = anchor.dataset.tipKeys ?? '';
    const trend = anchor.dataset.monthTrend;
    if (shown !== `${text}\n${keys}\n${trend}`) {
      shown = `${text}\n${keys}\n${trend}`;
      if (trend === undefined) el.textContent = text;
      else showMonthTip(el, text, trend);
      // Горячие клавиши — значками <kbd> после текста: «` или ⌘⇧B».
      keys
        .split('|')
        .filter(Boolean)
        .forEach((k, i) => {
          el.append(i ? ' или ' : ' ');
          el.appendChild(doc.createElement('kbd')).textContent = k;
        });
    }
    el.hidden = false;
    const view = doc.defaultView!;
    const { x, y } = tipPlacement(anchor.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, view.innerWidth, view.innerHeight, anchor.hasAttribute('data-tip-end'));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  const schedule = () => {
    if (anchor && !frame) frame = doc.defaultView!.requestAnimationFrame(update);
  };

  doc.addEventListener('pointerover', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    const a = tipOf(e.target);
    if (a === anchor) return;
    if (!a) return hide();
    anchor = a;
    if (!frame) update();
  });
  doc.addEventListener(
    'pointermove',
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      schedule();
    },
    { passive: true },
  );
  doc.addEventListener('scroll', schedule, { capture: true, passive: true });
  // Панели перерисовали (разметка, текст, подсказка, видимость) — но не сама плашка.
  new MutationObserver((records) => {
    if (records.some((r) => !el.contains(r.target))) schedule();
  }).observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-tip', 'data-tip-keys', 'data-month-trend', 'class', 'hidden'] });
  // Курсор ушёл из окна.
  doc.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget) hide();
  });
  return el;
}
