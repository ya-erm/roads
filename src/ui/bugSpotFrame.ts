/**
 * Участок из баг-репорта поверх карты: партию открыли из сохранения отчёта (поле bugSpot, bugreport/spot.ts) —
 * место ошибки обведено синей пунктирной рамкой, как рамка копирования развязки, с ярлыком-жуком. Рамка
 * следует за камерой, мышь проходит сквозь неё на карту; ✕ на ярлыке убирает рамку. В сохранение партии
 * рамка не пишется: это пометка для того, кто разбирает отчёт.
 */

import { fitCamera, type WorldBox } from '../bugreport/spot';
import type { Camera } from '../render/camera';
import { bugSvg } from './bugReport';

export class BugSpotFrame {
  private readonly el: HTMLElement;
  private area: WorldBox | null = null;
  private raf = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'bug-spot-frame hidden';
    // В новый баг-репорт рамка прошлого не попадает.
    this.el.setAttribute('data-shot-skip', '');
    this.el.innerHTML = `<span class="bug-spot-tag" data-tip="Участок из баг-репорта: здесь игрок заметил ошибку"><i class="bug-spot-bug">${bugSvg(18)}</i><button data-bug-spot-close data-tip="Убрать рамку участка" aria-label="Убрать рамку участка">✕</button></span>`;
    this.el.querySelector('[data-bug-spot-close]')!.addEventListener('click', () => this.show(null));
    // Нажатия на ярлык — не карте.
    for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu'] as const) this.el.addEventListener(t, (e) => e.stopPropagation());
    // Сразу над картой и под панелями игры (#hud идёт после холста).
    canvas.after(this.el);
  }

  /** Участок, который показывает рамка (null — рамки нет). */
  get shown(): WorldBox | null {
    return this.area;
  }

  /**
   * Показать участок (null — убрать). reveal — если участок не помещается на экране, камера встаёт на него:
   * у того, кто открыл отчёт, окно может быть меньше, чем у игрока.
   */
  show(area: WorldBox | null, opts: { reveal?: boolean } = {}): void {
    this.area = area;
    cancelAnimationFrame(this.raf);
    this.el.classList.toggle('hidden', !area);
    if (!area) return;
    if (opts.reveal && !this.fits(area)) {
      Object.assign(this.camera, fitCamera(area, this.camera.width, this.camera.height, { minZoom: this.camera.minZoom, maxZoom: this.camera.maxZoom }));
      this.camera.touched = true;
    }
    const tick = () => {
      this.place();
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  private fits(a: WorldBox): boolean {
    const c = this.camera;
    const p = c.toScreen({ x: a.x0, y: a.y0 });
    const q = c.toScreen({ x: a.x1, y: a.y1 });
    return p.x >= 0 && p.y >= 0 && q.x <= c.width && q.y <= c.height;
  }

  private place(): void {
    const a = this.area;
    if (!a) return;
    const r = this.canvas.getBoundingClientRect();
    const p = this.camera.toScreen({ x: a.x0, y: a.y0 });
    const q = this.camera.toScreen({ x: a.x1, y: a.y1 });
    const s = this.el.style;
    s.left = `${r.left + p.x}px`;
    s.top = `${r.top + p.y}px`;
    s.width = `${Math.max(4, q.x - p.x)}px`;
    s.height = `${Math.max(4, q.y - p.y)}px`;
  }
}
