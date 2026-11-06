/**
 * Кадр без изменений не перерисовывается — на паузе это экономит батарею. Рисуем, если:
 * - поменялась подпись кадра (камера, партия, время игры, версии сети, деньги, линии… — src/main.ts);
 * - в прошлом кадре было движущееся: игра идёт (машины), мигают переезды, дым и огонь предприятий, пульсирует
 *   подсветка, плитки кэша карты не дорисованы, зум ещё не устоялся (Renderer.needsFrame);
 * - недавно был ввод: мышь, колесо, клавиши, окно (poke), — ещё INPUT_TAIL_MS после него.
 * Лучше перерисовать лишний раз, чем пропустить нужное: всё сомнительное — повод рисовать.
 */

/** Сколько мс после ввода кадры рисуются в любом случае: его следствия могут дойти до картинки не сразу. */
export const INPUT_TAIL_MS = 250;

export class RedrawGate {
  private key: readonly unknown[] = [];
  private until = Number.NEGATIVE_INFINITY;

  /** Ввод или внешнее событие (смена настроек, окна): рисовать ещё INPUT_TAIL_MS. */
  poke(now: number): void {
    this.until = Math.max(this.until, now + INPUT_TAIL_MS);
  }

  /** Нужен ли кадр сейчас: key — подпись кадра (сравнивается поэлементно), moving — в кадре есть движущееся. */
  need(now: number, key: readonly unknown[], moving: boolean): boolean {
    const changed = key.length !== this.key.length || key.some((v, i) => !Object.is(v, this.key[i]));
    if (changed) this.key = [...key];
    return changed || moving || now < this.until;
  }
}
