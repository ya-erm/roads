import { describe, expect, it } from 'vitest';
import type { VehicleLook } from '../sim/vehicle';
import { drawVehicleArt, SERVICE_ART, SIREN_ZOOM, sirenVisibility } from './vehicleArt';

/** Холст-заглушка: рисование — пустые вызовы, все цвета заливки и обводки — копит. */
function stubCanvas() {
  const colors = new Set<string>();
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => {
      if (k === 'fillStyle' || k === 'strokeStyle') colors.add(String(v));
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, colors };
}

const AMBULANCE: VehicleLook = {
  kind: 'car',
  body: 'ambulance',
  length: 8,
  width: 4.2,
  color: '#f4f5f2',
  pos: { x: 0, y: 0 },
  dir: { x: 1, y: 0 },
  blinker: 0,
  siren: true,
};

describe('Мигалки издали', () => {
  it('вблизи — во всю силу, отдаляясь — плавно гаснут, совсем издали не видны', () => {
    const [far, near] = SIREN_ZOOM;
    expect(sirenVisibility(near)).toBe(1);
    expect(sirenVisibility(3)).toBe(1);
    expect(sirenVisibility(far)).toBe(0);
    expect(sirenVisibility(0.08)).toBe(0);
    // Между — плавно и без скачков: чем дальше, тем бледнее.
    let prev = 0;
    for (let z = far; z <= near; z += 0.01) {
      const k = sirenVisibility(z);
      expect(k).toBeGreaterThanOrEqual(prev);
      expect(k - prev).toBeLessThan(0.05);
      prev = k;
    }
    const mid = sirenVisibility((far + near) / 2);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
  });

  it('без flash (издали) мигалка на крыше не горит: ни белой вспышки, ни её цвета', () => {
    const [left] = SERVICE_ART.ambulance.lights;
    const on = stubCanvas();
    drawVehicleArt(on.ctx, AMBULANCE, { detailed: true, halo: 0, flash: -1 });
    expect(on.colors.has(left)).toBe(true);
    const off = stubCanvas();
    drawVehicleArt(off.ctx, AMBULANCE, { detailed: true, halo: 0 });
    expect(off.colors.has(left)).toBe(false);
  });
});
