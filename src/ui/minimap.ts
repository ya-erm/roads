import type { Game } from '../game/game';
import type { Camera } from '../render/camera';
import { smoothPath } from '../render/renderer';
import { cargoImage } from './cargoIcons';

const WIDTH = 200;

/** Миникарта: рельеф, дороги, города, предприятия и рамка обзора. Клик — перейти. */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private roads: HTMLCanvasElement | null = null;
  private roadsVersion = -1;
  private timer = 0;
  private dragging = false;

  constructor(
    parent: HTMLElement,
    private readonly game: () => Game,
    private readonly camera: Camera,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const go = (e: MouseEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const t = this.game().terrain;
      this.camera.x = ((e.clientX - r.left) / r.width) * t.width;
      this.camera.y = ((e.clientY - r.top) / r.height) * t.height;
      this.camera.touched = true;
      this.timer = 0;
    };
    this.canvas.addEventListener('mousedown', (e) => {
      this.dragging = true;
      go(e);
    });
    window.addEventListener('mousemove', (e) => this.dragging && go(e));
    window.addEventListener('mouseup', () => (this.dragging = false));
  }

  /** Сбрасывает кэш слоёв (например, для новой игры). */
  reset(): void {
    this.base = null;
    this.roads = null;
    this.timer = 0;
  }

  private size() {
    const t = this.game().terrain;
    return { w: WIDTH, h: Math.round((WIDTH * t.height) / t.width), k: WIDTH / t.width };
  }

  private layer(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement('canvas');
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    return [c, ctx];
  }

  private drawBase(): void {
    const g = this.game();
    const { w, h, k } = this.size();
    const [c, ctx] = this.layer(w, h);
    ctx.fillStyle = '#d6e2bd';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(110, 154, 82, 0.35)';
    for (const tree of g.terrain.trees) ctx.fillRect(tree.pos.x * k, tree.pos.y * k, 1, 1);
    ctx.strokeStyle = '#8cc3e6';
    ctx.fillStyle = '#8cc3e6';
    ctx.lineCap = 'round';
    for (const r of g.terrain.rivers) {
      ctx.lineWidth = Math.max(1.5, r.width * k);
      ctx.beginPath();
      smoothPath(ctx, r.points, k);
      ctx.stroke();
    }
    for (const lake of g.terrain.lakes) {
      ctx.beginPath();
      ctx.arc(lake.center.x * k, lake.center.y * k, lake.radius * k, 0, Math.PI * 2);
      ctx.fill();
    }
    this.base = c;
  }

  private drawRoads(): void {
    const g = this.game();
    const { w, h, k } = this.size();
    const [c, ctx] = this.layer(w, h);
    ctx.strokeStyle = '#4b525c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const s of g.net.segments.values()) {
      ctx.moveTo(s.curve.p0.x * k, s.curve.p0.y * k);
      ctx.bezierCurveTo(s.curve.p1.x * k, s.curve.p1.y * k, s.curve.p2.x * k, s.curve.p2.y * k, s.curve.p3.x * k, s.curve.p3.y * k);
    }
    ctx.stroke();
    this.roads = c;
    this.roadsVersion = g.net.version;
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    const g = this.game();
    const { w, h, k } = this.size();
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== w * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      this.base = null;
    }
    if (!this.base) this.drawBase();
    if (!this.roads || this.roadsVersion !== g.net.version) this.drawRoads();
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(this.base!, 0, 0, w, h);
    ctx.drawImage(this.roads!, 0, 0, w, h);
    for (const t of g.towns) {
      ctx.fillStyle = 'rgba(85, 96, 110, 0.55)';
      ctx.beginPath();
      ctx.arc(t.center.x * k, t.center.y * k, Math.max(3, t.radius * k), 0, Math.PI * 2);
      ctx.fill();
    }
    for (const ind of g.industries) {
      const img = cargoImage(ind.info.produces);
      if (img.complete) ctx.drawImage(img, ind.fp.center.x * k - 5, ind.fp.center.y * k - 5, 10, 10);
    }
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#2f80ed';
    for (const st of g.stations.values()) {
      ctx.beginPath();
      ctx.arc(st.fp.center.x * k, st.fp.center.y * k, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const a = this.camera.toWorld(0, 0);
    const b = this.camera.toWorld(this.camera.width, this.camera.height);
    ctx.strokeStyle = '#1f2933';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x * k, a.y * k, (b.x - a.x) * k, (b.y - a.y) * k);
  }
}
