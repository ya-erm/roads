import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dist, type Vec } from '../core/vec';
import { freshGame, withoutCitizens } from '../game/testkit';
import { Camera } from '../render/camera';
import type { TownPark } from '../world/entities';
import { NEW_GAME_SETTINGS } from '../world/settings';
import { footprintRadius } from '../world/spatial';
import { Controller } from './controller';

/** «Выбор» по парку: клик по газону — карточка парка, по дому рядом — дом (здания главнее зелени). */

type Handler = (e: unknown) => void;

class Events {
  private readonly map = new Map<string, Handler[]>();
  addEventListener(type: string, h: Handler): void {
    this.map.set(type, [...(this.map.get(type) ?? []), h]);
  }
  fire(type: string, e: unknown): void {
    for (const h of this.map.get(type) ?? []) h(e);
  }
}

const win = new Events();
const saved = { window: (globalThis as Record<string, unknown>).window, input: (globalThis as Record<string, unknown>).HTMLInputElement };

beforeAll(() => {
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).HTMLInputElement = class {};
});

afterAll(() => {
  (globalThis as Record<string, unknown>).window = saved.window;
  (globalThis as Record<string, unknown>).HTMLInputElement = saved.input;
});

const local = (p: TownPark, u: number, v: number): Vec => {
  const c = Math.cos(p.fp.angle);
  const s = Math.sin(p.fp.angle);
  return { x: p.fp.center.x + u * c - v * s, y: p.fp.center.y + u * s + v * c };
};

describe('«Выбор» по парку', { timeout: 60_000 }, () => {
  it('клик по газону — парк (и подпись у курсора); по дому у парка — дом', () => {
    const game = withoutCitizens(freshGame({ ...NEW_GAME_SETTINGS, seed: 1 }));
    const canvas = new Events();
    const camera = new Camera();
    camera.width = 0;
    camera.height = 0;
    const c = new Controller(canvas as unknown as HTMLCanvasElement, camera, () => game);
    const mouse = (p: Vec) => ({ clientX: p.x, clientY: p.y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, target: canvas, preventDefault() {} });
    const click = (p: Vec) => {
      canvas.fire('mousedown', mouse(p));
      win.fire('mouseup', mouse(p));
    };
    expect(c.tool).toBe('select');

    const town = game.towns.find((t) => t.parks?.some((p) => p.kind === 'park'))!;
    const park = town.parks!.find((p) => p.kind === 'park')!;
    const lawn = local(park, 0, park.fp.h * 0.3);
    click(lawn);
    expect(c.selection).toEqual({ type: 'park', id: park.id });
    c.hover = lawn;
    expect(c.overlay().label?.text).toBe(`🌳 Парк · ${town.name}`);

    // Дом у края любого парка мира: клик по нему — дом, не парк.
    let house: { id: number; at: Vec } | null = null;
    for (const t of game.towns) {
      for (const p of t.parks ?? []) {
        const b = t.buildings.find((x) => x.kind !== 'landmark' && dist(x.fp.center, p.fp.center) < footprintRadius(p.fp) + footprintRadius(x.fp) + 6);
        if (b) house = { id: b.id, at: b.fp.center };
        if (house) break;
      }
      if (house) break;
    }
    expect(house).not.toBeNull();
    click(house!.at);
    expect(c.selection).toEqual({ type: 'building', id: house!.id });

    // Площадь у ратуши — своя карточка; сама ратуша рядом — здание.
    const plazaTown = game.towns.find((t) => t.parks?.some((p) => p.kind === 'plaza'))!;
    const plaza = plazaTown.parks!.find((p) => p.kind === 'plaza')!;
    click(local(plaza, plaza.fp.w * 0.3, plaza.fp.h * 0.3));
    expect(c.selection).toEqual({ type: 'park', id: plaza.id });
    const hall = plazaTown.buildings.find((b) => b.kind === 'landmark')!;
    click(hall.fp.center);
    expect(c.selection).toEqual({ type: 'building', id: hall.id });
  });
});
