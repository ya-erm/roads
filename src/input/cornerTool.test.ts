import { describe, expect, it } from 'vitest';
import { add, dist, scale, type Vec } from '../core/vec';
import { Game } from '../game/game';
import { road } from '../game/testkit';
import { cornerHandles, type CornerHandle } from '../lanes/corners';
import { filletDepth } from '../lanes/geometry';
import { RoadTools } from './roadtools';

/** Острый угол «косого» перекрёстка, рад: улица с запада на восток и вторая — под ним, на северо-восток. */
const ANGLE = 0.6;

/** Косой перекрёсток двух улиц в чистом поле: id узла и его острый угол между восточной и северо-восточной ветками. */
function skewCross(game: Game): { node: number; at: Vec } {
  for (let y = 500; y < game.terrain.height - 500; y += 150) {
    for (let x = 500; x < game.terrain.width - 500; x += 200) {
      const d = { x: Math.cos(-ANGLE), y: Math.sin(-ANGLE) };
      if (!road(game, { free: { x: x - 300, y } }, { free: { x: x + 300, y } })) continue;
      if (!road(game, { free: add({ x, y }, scale(d, -300)) }, { free: add({ x, y }, scale(d, 300)) })) continue;
      const n = game.roads.net.nodesNear({ x, y }, 3).find((m) => m.kind === 'junction');
      if (n) return { node: n.id, at: { x, y } };
    }
  }
  throw new Error('нет места');
}

/** Ручка острого угла узла. */
const acute = (game: Game, node: number): CornerHandle => cornerHandles(game.roads.net, game.roads.net.node(node)).find((h) => Math.abs(h.corner.theta - ANGLE) < 0.01)!;
/** Куда дотянуть ручку, чтобы вышел радиус r. */
const pull = (h: CornerHandle, r: number) => add(h.corner.apex, scale(h.corner.out, filletDepth(r, h.corner.theta)));

/** Правый поворот вдоль угла h в графе игры: скорость манёвра с подъезда b на подъезд a. */
function turnSpeed(game: Game, h: CornerHandle): number {
  const g = game.roads.graph;
  const moves = [...g.moves.values()].filter((m) => m.node === h.node && g.links.get(m.inLink)?.corridor === h.corner.b.corridor.id && g.links.get(m.outLink)?.corridor === h.corner.a.corridor.id);
  return Math.max(...moves.map((m) => m.speed));
}

describe('«Двигать»: скругление угла перекрёстка', () => {
  const game = new Game({ seed: 11, size: 'small', towns: 0, industries: 'few', money: 5_000_000, water: 'dry' });
  const { node } = skewCross(game);
  const tools = new RoadTools(() => game);

  it('за середину бордюра угол тянут наружу — радиус растёт, поворот быстрее; Ctrl+Z — одним шагом', () => {
    const h = acute(game, node);
    expect(h).toBeDefined();
    expect(h.radius).toBeUndefined();
    const slow = turnSpeed(game, h);
    const money = game.money;
    game.checkpoint('скругление угла');
    expect(tools.moveDown(h.pos, 14, 6)).toBe(true);
    expect(tools.corner?.corner.key).toBe(h.corner.key);
    // Дальше предела — у курсора, почему: здесь стоп-линию не уводят дальше 150 м от перекрёстка.
    tools.movePlan(pull(h, 1000));
    expect(tools.hint).toBe(`радиус ${Math.round(h.max)} м — предел: стоп-линия дальше 150 м от перекрёстка`);
    const plan = tools.movePlan(pull(h, 25))!;
    expect(plan.ok).toBe(true);
    // Асфальт угла стоит денег.
    expect(plan.cost).toBeGreaterThan(0);
    expect(tools.hint).toBe('радиус 25 м');
    const sign = tools.cornerSign(plan.net!)!;
    expect(sign.radius).toBe(25);
    expect(tools.moveUp(pull(h, 25), true)).toBeNull();
    game.commit();
    expect(game.roads.net.node(node).corners).toEqual({ [h.corner.key]: 25 });
    expect(game.money).toBeLessThan(money);
    const fast = turnSpeed(game, h);
    expect(fast).toBeGreaterThan(slow * 1.5);
    // Подпись у курсора — та же скорость поворота, что у машин.
    expect(sign.kmh).toBeCloseTo(fast * 2.2, 0);
    // Ручка теперь на новой дуге.
    expect(dist(acute(game, node).pos, pull(h, 25))).toBeLessThan(1.5);

    expect(game.undo()).toBe('скругление угла');
    expect(game.roads.net.node(node).corners).toBeUndefined();
    expect(game.money).toBe(money);
    expect(turnSpeed(game, h)).toBeCloseTo(slow, 6);
  });

  it('радиус сохраняется в партии', () => {
    const h = acute(game, node);
    tools.moveDown(h.pos, 14, 6);
    expect(tools.moveUp(pull(h, 20), true)).toBeNull();
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.roads.net.node(node).corners).toEqual({ [h.corner.key]: 20 });
    expect(turnSpeed(loaded, h)).toBeCloseTo(turnSpeed(game, h), 6);
  });

  it('угол не заходит на чужую дорогу: дальше — красным с причиной', () => {
    const h = acute(game, node);
    // Улица внутри острого угла, вдоль его биссектрисы: начинается в 75 м от вершины.
    const from = add(h.corner.apex, scale(h.corner.out, 75));
    expect(road(game, { free: from }, { free: add(from, scale(h.corner.out, 80)) })).toBe(true);
    const fresh = acute(game, node);
    tools.moveDown(fresh.pos, 14, 6);
    expect(tools.movePlan(pull(fresh, 15))!.ok).toBe(true);
    const far = tools.movePlan(pull(fresh, 30))!;
    expect(far.ok).toBe(false);
    expect(far.reason).toBe('Угол заходит на другую дорогу');
    tools.moveEnd();
  });

  it('«Перекрёсток»: у выбранного перекрёстка те же ручки углов — у бордюров, не на метках полос; скругление — тем же ходом', () => {
    // Второй острый угол (первый уже скруглён и подпёрт улицей).
    const h = cornerHandles(game.roads.net, game.roads.net.node(node)).find((x) => Math.abs(x.corner.theta - ANGLE) < 0.01 && !x.radius)!;
    expect(h).toBeDefined();
    const marks = tools.nodeCornerMarks(node, 2);
    expect(marks.some((m) => dist(m.pos, h.pos) < 0.01)).toBe(true);
    // Ручки — у бордюров, метки полос (связи полос) — у стоп-линий: зоны попадания не пересекаются.
    const ends = game.laneEnds(node);
    expect(ends.length).toBeGreaterThan(0);
    for (const e of ends) for (const m of marks) expect(dist(e.pos, m.pos)).toBeGreaterThan(6);
    // Как контроллер в «Перекрёстке»: взяли ручку — снимок для Ctrl+Z, отпустили — скругление построено.
    game.checkpoint('скругление угла');
    tools.corner = tools.cornerAt(h.pos, 3);
    expect(tools.corner?.corner.key).toBe(h.corner.key);
    expect(tools.moveUp(pull(h, 18), true)).toBeNull();
    game.commit();
    expect(game.roads.net.node(node).corners?.[h.corner.key]).toBe(18);
    expect(game.undo()).toBe('скругление угла');
    expect(game.roads.net.node(node).corners?.[h.corner.key]).toBeUndefined();
  });
});
