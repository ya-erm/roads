import type { Vec } from '../core/vec';

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  width = 1;
  height = 1;
  dpr = 1;
  readonly minZoom = 0.08;
  readonly maxZoom = 3;
  /** Игрок двигал камеру вручную — тогда не перестраиваем вид при ресайзе. */
  touched = false;

  toWorld(sx: number, sy: number): Vec {
    return {
      x: (sx - this.width / 2) / this.zoom + this.x,
      y: (sy - this.height / 2) / this.zoom + this.y,
    };
  }

  toScreen(p: Vec): Vec {
    return {
      x: (p.x - this.x) * this.zoom + this.width / 2,
      y: (p.y - this.y) * this.zoom + this.height / 2,
    };
  }

  /** Зум с сохранением точки под курсором. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  fit(w: number, h: number, margin = 40): void {
    this.x = w / 2;
    this.y = h / 2;
    const z = Math.min((this.width - margin * 2) / w, (this.height - margin * 2) / h);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, z));
    this.touched = false;
  }

  clamp(w: number, h: number): void {
    this.x = Math.max(0, Math.min(w, this.x));
    this.y = Math.max(0, Math.min(h, this.y));
  }

  apply(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(
      this.zoom * this.dpr,
      0,
      0,
      this.zoom * this.dpr,
      (this.width / 2 - this.x * this.zoom) * this.dpr,
      (this.height / 2 - this.y * this.zoom) * this.dpr,
    );
  }
}
