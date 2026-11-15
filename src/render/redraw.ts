/**
 * Кадр без изменений не перерисовывается — на паузе это экономит батарею. Рисуем, если:
 * - поменялся вид (камера, размер окна, инструмент, выбор, курсор, партия — src/main.ts) — сразу, в этом же кадре:
 *   прокрутка и зум идут с частотой экрана;
 * - поменялось состояние партии (время, сеть, деньги, линии…) или в кадре есть живое движение: игра идёт (машины),
 *   плитки кэша карты не дорисованы, зум ещё не устоялся, пульсирует подсветка (Renderer.motion = 'live') — не чаще
 *   MAX_FPS: на экране 120 Гц (ProMotion) карта во весь экран иначе перерисовывалась бы 120 раз в секунду;
 * - движется только фон — дым и огонь предприятий, качалки, огни закрытого переезда (Renderer.motion = 'ambient') —
 *   не чаще AMBIENT_FPS: на паузе ради дыма карта не перерисовывается с частотой экрана;
 * - недавно был ввод: мышь, колесо, клавиши, окно (poke), — ещё INPUT_TAIL_MS после него (как живое движение).
 * Лучше перерисовать лишний раз, чем пропустить нужное: всё сомнительное — повод рисовать.
 */

/** Сколько мс после ввода кадры рисуются в любом случае: его следствия могут дойти до картинки не сразу. */
export const INPUT_TAIL_MS = 250;
/** Кадров в секунду, когда на карте живое движение (игра идёт) или поменялось состояние партии. */
export const MAX_FPS = 60;
/** Кадров в секунду, когда движется только фон (дым, огонь, качалки, мигание переезда). */
export const AMBIENT_FPS = 30;
/**
 * Допуск к интервалу кадра, мс: кадры requestAnimationFrame приходят по вертикальной развёртке экрана, и на 60 Гц
 * каждый (16,7 мс) должен пройти порог 1000 / MAX_FPS, а на 120 Гц — каждый второй.
 */
const SLACK_MS = 3;

/** Что движется в кадре само: ничего, только фон (можно реже) или живое (не реже MAX_FPS). */
export type Motion = 'none' | 'ambient' | 'live';

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

export class RedrawGate {
  private view: readonly unknown[] = [];
  private state: readonly unknown[] = [];
  /** Состояние партии поменялось, а кадр с ним ещё не нарисован (ждёт интервала MAX_FPS). */
  private pending = false;
  private until = Number.NEGATIVE_INFINITY;
  private last = Number.NEGATIVE_INFINITY;

  /** Ввод или внешнее событие (смена настроек, окна): рисовать ещё INPUT_TAIL_MS. */
  poke(now: number): void {
    this.until = Math.max(this.until, now + INPUT_TAIL_MS);
  }

  /**
   * Нужен ли кадр сейчас. view — подпись вида (поменялась — рисуем сразу), state — подпись состояния партии
   * (поменялась — рисуем не чаще MAX_FPS); подписи сравниваются поэлементно. motion — что движется в кадре само.
   */
  need(now: number, view: readonly unknown[], state: readonly unknown[], motion: Motion): boolean {
    let draw = false;
    if (!same(view, this.view)) {
      this.view = [...view];
      draw = true;
    }
    if (!same(state, this.state)) {
      this.state = [...state];
      this.pending = true;
    }
    if (draw) this.last = now;
    else {
      const fps = this.pending || motion === 'live' || now < this.until ? MAX_FPS : motion === 'ambient' ? AMBIENT_FPS : 0;
      const step = 1000 / fps;
      draw = fps > 0 && now - this.last >= step - SLACK_MS;
      // По сетке шага, а не от кадра: на экране 144 Гц и выше в среднем ровно fps, а не 1000 / (шаг − допуск).
      if (draw) this.last = now - this.last > 2 * step ? now : this.last + step;
    }
    if (draw) this.pending = false;
    return draw;
  }
}
