import { describe, expect, it } from 'vitest';
import { LaneRenderer } from '../lanes/draw';
import { Game } from './game';
import { STREET } from './testkit';

/** Что нарисовано: отпечатки и рамки всех полотен и узлов. */
function picture(r: LaneRenderer, game: Game): string[] {
  const out: string[] = [];
  r.eachItem(game.roads.net, (kind, id, sig, box) => out.push(`${kind}${id}:${sig}:${box.x0},${box.y0},${box.x1},${box.y1}`));
  return out.sort();
}

/** Узлы, чья геометрия посчитана заново после правки. */
function redone(r: LaneRenderer, game: Game, act: () => void): number[] {
  const cache = () => r['nodeCache'] as Map<number, { geo: unknown }>;
  const was = new Map([...cache()].map(([id, x]) => [id, x.geo]));
  act();
  r.eachItem(game.roads.net, () => {});
  return [...cache()].filter(([id, x]) => was.get(id) !== x.geo).map(([id]) => id);
}

describe('Стройка: отрисовка дорог пересчитывается только у правки', { timeout: 60_000 }, () => {
  it('примыкание к перекрёстку: заново — он и новый тупик, не соседние перекрёстки; картинка — как с нуля', () => {
    const game = new Game(7);
    game.money = 1e9;
    const r = new LaneRenderer();
    picture(r, game);
    const net = game.roads.net;
    // Обычный перекрёсток на четыре стороны (у площади в центре города улиц бывает и больше — там тесно).
    const j = [...net.nodes.values()].filter((n) => n.kind === 'junction' && n.corridors.length === 4).sort((a, b) => a.id - b.id)[0];
    let plan = null;
    for (let k = 0; k < 16 && !plan?.ok; k++) {
      const ang = (k / 16) * Math.PI * 2;
      plan = game.roadBuilder.road({ kind: 'node', node: j.id, pos: j.pos }, { kind: 'free', pos: { x: j.pos.x + Math.cos(ang) * 120, y: j.pos.y + Math.sin(ang) * 120 } }, STREET);
    }
    expect(plan?.ok).toBe(true);
    const before = new Set(net.nodes.keys());
    const ids = redone(r, game, () => game.roadBuilder.apply(plan!));
    // Соседи перекрёстка (на других концах его дорог) — как были.
    const fresh = ids.filter((id) => before.has(id));
    expect(fresh).toEqual([j.id]);
    expect(picture(r, game)).toEqual(picture(new LaneRenderer(), game));
    // Снос дороги перекрёстка — заново только оба её конца.
    const c = game.roads.net.corridor(game.roads.net.node(j.id).corridors[0]);
    const ends = [c.a, c.b].filter((id) => game.roads.net.node(id).kind === 'junction');
    const ids2 = redone(r, game, () => game.roadBuilder.apply(game.roadBuilder.bulldoze([c.id])));
    for (const id of ids2) expect([c.a, c.b]).toContain(id);
    for (const id of ends) expect(ids2).toContain(id);
    expect(picture(r, game)).toEqual(picture(new LaneRenderer(), game));
  });
});
