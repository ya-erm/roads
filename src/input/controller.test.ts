import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { add, dot, scale, Vec } from '../core/vec';
import { Game } from '../game/game';
import { freshGame, road, roadPlan, STREET } from '../game/testkit';
import { cornerHandles, type CornerHandle } from '../lanes/corners';
import { filletDepth } from '../lanes/geometry';
import { junctionPlate } from '../world/lotClear';
import { NEW_GAME_SETTINGS } from '../world/settings';
import { LOT, lotGateDriveway, lotStallCount, lotWidth } from '../world/parkingLots';
import { lotHandles } from './lotTool';
import type { LaneNet } from '../lanes/model';
import { Camera } from '../render/camera';
import { Controller, dropEffectFor, isNodeDoubleClick } from './controller';

describe('Знак скорости отпускают тем действием, что разрешено', () => {
  it('без клавиш — копировать; с Cmd на macOS — переместить, с Ctrl — ссылка', () => {
    expect(dropEffectFor('all')).toBe('copy');
    expect(dropEffectFor('uninitialized')).toBe('copy');
    expect(dropEffectFor('copyMove')).toBe('copy');
    expect(dropEffectFor('move')).toBe('move');
    expect(dropEffectFor('linkMove')).toBe('move');
    expect(dropEffectFor('link')).toBe('link');
  });
});

type Handler = (e: unknown) => void;

/** Подписки на события — вместо окна и холста (тесты идут без браузера). */
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

/** Тупик o → излом K (o + 200 по x) → поворот на 45° до o + (350, −150): дорога изломом из двух полотен. */
function kinkGame(): { game: Game; o: Vec; K: number } {
  const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
  for (let y = 500; y < game.terrain.height - 600; y += 140) {
    for (let x = 400; x < game.terrain.width - 700; x += 170) {
      const o = { x, y };
      if (!roadPlan(game, { free: add(o, { x: -40, y: 160 }) }, { free: add(o, { x: 440, y: -160 }) }).ok || !roadPlan(game, { free: o }, { free: add(o, { x: 400, y: 0 }) }).ok) continue;
      expect(road(game, { free: o }, { free: add(o, { x: 200, y: 0 }) })).toBe(true);
      const K = game.roads.net.nodesNear(add(o, { x: 200, y: 0 }), 1)[0].id;
      expect(road(game, K, { free: add(o, { x: 350, y: -150 }) }, { ...STREET, kink: true })).toBe(true);
      expect(game.roads.net.node(K).kind).toBe('junction');
      return { game, o, K };
    }
  }
  throw new Error('Нет места');
}

/**
 * «Дорога → Двигать» с мышью и клавиатурой, как в браузере: mousedown — на холсте, mousemove и mouseup — на окне,
 * у каждого клика серии — свой detail (1, 2), после серии — dblclick. Камера — пиксель экрана на метр мира.
 */
function play(game: Game) {
  const canvas = new Events();
  const camera = new Camera();
  camera.width = 0;
  camera.height = 0;
  const c = new Controller(canvas as unknown as HTMLCanvasElement, camera, () => game);
  const mouse = (p: Vec, detail = 1) => ({ clientX: p.x, clientY: p.y, button: 0, detail, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, target: canvas, preventDefault() {} });
  const move = (p: Vec) => win.fire('mousemove', mouse(p, 0));
  const key = (code: string, extra: Record<string, unknown> = {}) =>
    win.fire('keydown', { code, key: code.replace(/^Key/, '').toLowerCase(), ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault() {}, ...extra });
  const click = (p: Vec, detail = 1) => {
    move(p);
    canvas.fire('mousedown', mouse(p, detail));
    win.fire('mouseup', mouse(p, detail));
  };
  /** Двойной клик: down/up (detail 1), down/up (detail 2), dblclick — второй клик чуть сдвинут, как рукой. */
  const dblclick = (p: Vec) => {
    click(p, 1);
    click(add(p, { x: 1, y: 1 }), 2);
    canvas.fire('dblclick', mouse(p, 2));
  };
  c.setTool('road');
  c.setRoadMode('move');
  return { c, canvas, camera, mouse, move, click, dblclick, key };
}

it('размещение автомобиля оставляет доступными правую протяжку карты и масштаб колесом', () => {
  const { c, canvas, camera, mouse, move } = play(freshGame({ ...NEW_GAME_SETTINGS, seed: 1 }));
  c.setTool('select');
  c.testVehiclePlacement = true;
  camera.x = 1500; camera.y = 1500; camera.zoom = 1;
  canvas.fire('mousedown', { ...mouse({ x: 100, y: 100 }), button: 2 });
  move({ x: 140, y: 125 });
  win.fire('mouseup', { ...mouse({ x: 140, y: 125 }), button: 2 });
  expect(camera.x).toBe(1460);
  expect(camera.y).toBe(1475);
  canvas.fire('wheel', { ...mouse({ x: 140, y: 125 }), deltaY: -100, deltaX: 0 });
  expect(camera.zoom).toBeGreaterThan(1);
  expect(c.testVehiclePlacement).toBe(true);
});

/** Перья двух дорог в узле id смотрят в противоположные стороны — узел гладкий. */
function pensOpposite(net: LaneNet, id: number): boolean {
  const n = net.node(id);
  const [a, b] = n.corridors.map((cid) => {
    const c = net.corridor(cid);
    const t = c.a === id ? c.lut.tangentAt(0) : c.lut.tangentAt(c.length);
    return c.a === id ? t : { x: -t.x, y: -t.y };
  });
  return dot(a, b) < -0.9999;
}

const shapes = (net: LaneNet, id: number) => net.node(id).corridors.map((cid) => JSON.stringify(net.corridor(cid).curve));

describe('«Двигать»: двойной клик по узлу — излом ↔ гладкий', () => {
  it('второй клик серии по тому же узлу — двойной; по дороге, где узел встал первым кликом, — нет', () => {
    expect(isNodeDoubleClick(7, 7, 2)).toBe(true);
    // Первый клик был по дороге (узел только что встал) — прежнего клика по узлу нет.
    expect(isNodeDoubleClick(null, 7, 2)).toBe(false);
    // Другой узел или одиночный клик — не двойной. Скорость — по системе (detail): медленный двойной — тоже двойной.
    expect(isNodeDoubleClick(3, 7, 2)).toBe(false);
    expect(isNodeDoubleClick(7, 7, 1)).toBe(false);
  });

  it('через обработчики мыши: излом становится гладким и таким остаётся — после клика мимо и времени в игре', () => {
    const { game, o, K } = kinkGame();
    const { c, click, dblclick, key } = play(game);
    expect(c.moveProjectMode).toBe(false);
    const P = game.roads.net.node(K).pos;
    dblclick(P);
    let net = game.roads.net;
    expect(net.node(K).kind).toBe('seam');
    expect(pensOpposite(net, K)).toBe(true);
    const smooth = shapes(net, K);
    // Клик по пустому месту и время в игре — гладкий узел остаётся гладким, форма — та же.
    click(add(o, { x: 100, y: 120 }));
    game.speed = 1;
    for (let i = 0; i < 30; i++) game.update(0.1);
    net = game.roads.net;
    expect(net.node(K).kind).toBe('seam');
    expect(shapes(net, K)).toEqual(smooth);
    // Снова двойной клик — излом (форма та же), Ctrl+Z — снова гладкий.
    dblclick(P);
    expect(game.roads.net.node(K).kind).toBe('junction');
    expect(shapes(game.roads.net, K)).toEqual(smooth);
    key('KeyZ', { ctrlKey: true });
    expect(game.roads.net.node(K).kind).toBe('seam');
  });

  it('пока кнопку держат на месте (клик, двойной клик), узел не прыгает к курсору: предпросмотра переноса нет', () => {
    const { game, K } = kinkGame();
    const { c, canvas, mouse, move } = play(game);
    const at = add(game.roads.net.node(K).pos, { x: 4, y: 3 });
    move(at);
    canvas.fire('mousedown', mouse(at));
    move(add(at, { x: 2, y: 0 }));
    // Подпись — как у узла под курсором (с двойным кликом), а не перенос с ценой.
    expect(c.overlay().label?.text).toMatch(/двойной клик/);
    // Потянули дальше клика — предпросмотр переноса.
    move(add(at, { x: 30, y: 20 }));
    expect(c.overlay().label?.text ?? '').not.toMatch(/двойной клик/);
    win.fire('mouseup', mouse(add(at, { x: 30, y: 20 })));
  });

  it('двойной клик по дороге: первый клик ставит узел, второй его не переключает', () => {
    const { game, o } = kinkGame();
    const { dblclick } = play(game);
    const nodes = game.roads.net.nodes.size;
    const p = add(o, { x: 100, y: 0 });
    dblclick(p);
    const net = game.roads.net;
    expect(net.nodes.size).toBe(nodes + 1);
    expect(net.nodesNear(p, 2)[0].kind).toBe('seam');
  });

  it('в «Проекте» двойной клик — правка проекта: дорога пока изломом, в проекте узел гладкий', () => {
    const { game, K } = kinkGame();
    const { c, dblclick, key } = play(game);
    key('KeyP');
    expect(c.moveProjectMode).toBe(true);
    dblclick(game.roads.net.node(K).pos);
    expect(game.roads.net.node(K).kind).toBe('junction');
    expect(c.moveProject.hasWork).toBe(true);
    const planned = c.moveProject.plan().net!;
    expect(planned.node(K).kind).toBe('seam');
    expect(pensOpposite(planned, K)).toBe(true);
  });
});

describe('Превью инструмента у курсора — из кэша', () => {
  it('курсор и сеть те же — план дороги считается раз; деньги — отдельно, без пересчёта; сдвинули курсор — заново', () => {
    const { game, o } = kinkGame();
    const { c, move } = play(game);
    c.setRoadMode('build');
    c.projectTools.on.road = false;
    const rt = c.roadTools;
    let plans = 0;
    const buildPlan = rt.buildPlan.bind(rt);
    rt.buildPlan = (...args) => (plans++, buildPlan(...args));
    rt.begin(add(o, { x: 0, y: 100 }), 12);
    move(add(o, { x: 200, y: 100 }));
    const label = c.overlay().label?.text;
    expect(label).toMatch(/\d+ м/);
    for (let i = 0; i < 5; i++) expect(c.overlay().label?.text).toBe(label);
    expect(plans).toBe(1);
    // Денег не стало — подпись «Не хватает денег» сразу, план тот же.
    const money = game.money;
    game.money = -1e9;
    expect(c.overlay().label).toMatchObject({ ok: false, text: expect.stringMatching(/Не хватает денег/) });
    game.money = money;
    expect(c.overlay().label).toMatchObject({ ok: true, text: label });
    expect(plans).toBe(1);
    move(add(o, { x: 220, y: 100 }));
    c.overlay();
    expect(plans).toBe(2);
  });
});

/** Площадь многоугольника, м². */
const area = (poly: Vec[]) => Math.abs(poly.reduce((s, p, i) => s + p.x * poly[(i + 1) % poly.length].y - poly[(i + 1) % poly.length].x * p.y, 0)) / 2;

/** Косой перекрёсток двух улиц (острый угол 0,6 рад): игра, id узла и ручка его острого угла. */
function skewGame(): { game: Game; node: number; h: CornerHandle } {
  const game = new Game({ seed: 11, size: 'small', towns: 0, industries: 'few', money: 5_000_000, water: 'dry' });
  const d = { x: Math.cos(-0.6), y: Math.sin(-0.6) };
  for (let y = 500; y < game.terrain.height - 500; y += 150) {
    for (let x = 500; x < game.terrain.width - 500; x += 200) {
      if (!road(game, { free: { x: x - 300, y } }, { free: { x: x + 300, y } })) continue;
      if (!road(game, { free: add({ x, y }, scale(d, -300)) }, { free: add({ x, y }, scale(d, 300)) })) continue;
      const n = game.roads.net.nodesNear({ x, y }, 3).find((m) => m.kind === 'junction');
      const h = n && cornerHandles(game.roads.net, n).find((k) => Math.abs(k.corner.theta - 0.6) < 0.01);
      if (n && h) return { game, node: n.id, h };
    }
  }
  throw new Error('Нет места');
}

describe('«Двигать» с «Проектом»: скругление угла перекрёстка — предпросмотром', () => {
  /** Куда дотянуть ручку h, чтобы вышел радиус r. */
  const pull = (h: CornerHandle, r: number) => add(h.corner.apex, scale(h.corner.out, filletDepth(r, h.corner.theta)));
  /** Площадка узла в превью проекта (null — её там нет). */
  const plate = (o: ReturnType<Controller['overlay']>) => o.project?.plates?.[0]?.poly ?? null;

  it('пока тянут угол — площадка проекта со скруглением, растёт вслед за курсором; отпустили — в проекте, Esc — отмена', () => {
    const { game, node, h } = skewGame();
    const { c, canvas, mouse, move, key } = play(game);
    key('KeyP');
    expect(c.moveProjectMode).toBe(true);
    const built = junctionPlate(game.roads.net, game.roads.net.node(node))!;
    // Курсор у ручки — проекта ещё нет: площадки в превью нет.
    move(h.pos);
    expect(plate(c.overlay())).toBeNull();
    canvas.fire('mousedown', mouse(h.pos));
    move(pull(h, 15));
    const o15 = c.overlay();
    expect(o15.label?.text).toMatch(/радиус 15 м/);
    const p15 = plate(o15)!;
    // Площадка проекта — не та, что построена: угол скруглён, асфальта больше; обрезы у всех четырёх подъездов.
    expect(p15).not.toBeNull();
    expect(area(p15)).toBeGreaterThan(area(built) + 20);
    expect(o15.project!.plates![0].cuts).toHaveLength(4);
    // Кэш превью не залипает: курсор дальше — радиус больше, площадка шире; тот же курсор — та же площадка из кэша.
    move(pull(h, 30));
    const o30 = c.overlay();
    expect(o30.label?.text).toMatch(/радиус 30 м/);
    const p30 = plate(o30)!;
    expect(area(p30)).toBeGreaterThan(area(p15) + 20);
    expect(plate(c.overlay())).toBe(p30);
    move(pull(h, 15));
    expect(area(plate(c.overlay())!)).toBeCloseTo(area(p15), 6);
    move(pull(h, 30));
    // Отпустили — правка проекта: построенная дорога как была, площадка со скруглением видна и без протяжки.
    win.fire('mouseup', mouse(pull(h, 30)));
    expect(game.roads.net.node(node).corners).toBeUndefined();
    expect(c.moveProject.net()!.node(node).corners).toEqual({ [h.corner.key]: 30 });
    move(add(h.pos, { x: 200, y: 200 }));
    expect(area(plate(c.overlay())!)).toBeCloseTo(area(p30), 6);
    // Снова тянут тот же угол (от сети с проектом) — и Esc: превью — как в проекте, правка не добавилась.
    const net = c.moveProject.net()!;
    const again = cornerHandles(net, net.node(node)).find((k) => k.corner.key === h.corner.key)!;
    move(again.pos);
    canvas.fire('mousedown', mouse(again.pos));
    move(pull(h, 36));
    expect(area(plate(c.overlay())!)).toBeGreaterThan(area(p30) + 20);
    key('Escape');
    expect(area(plate(c.overlay())!)).toBeCloseTo(area(p30), 6);
    win.fire('mouseup', mouse(pull(h, 36)));
    expect(c.moveProject.edits).toHaveLength(1);
    expect(c.moveProject.net()!.node(node).corners).toEqual({ [h.corner.key]: 30 });
  });
});

describe('Что ждёт клика (pending) и поворот (R)', () => {
  it('новая партия: начатое в прежней — прочь, ни одного номера из неё', () => {
    const { game, o } = kinkGame();
    const { c } = play(game);
    const station = [...game.stations.keys()][0] ?? 1;
    c.startWarehouse(station);
    expect(c.pending).toEqual({ kind: 'warehouse', id: station });
    c.pendingArea = { a: o, b: add(o, { x: 50, y: 50 }), contents: game.areaContents(o, add(o, { x: 50, y: 50 })) };
    c.addStopTo = 3;
    c.phaseEdit = { node: 1, i: 0 };
    c.angle = 1;
    c.reset();
    expect([c.pending, c.pendingArea, c.addStopTo, c.phaseEdit, c.selection, c.angle]).toEqual([null, null, null, null, null, 0]);
  });

  it('R — шаг 15° у того, что ставят; нечего вертеть — false; новый инструмент — с нуля', () => {
    const { game } = kinkGame();
    const { c, key } = play(game);
    c.setTool('select');
    expect(c.rotateActive(1)).toBe(false);
    c.setTool('roundabout');
    c.setJunctionMode('template');
    key('KeyR');
    key('KeyR');
    key('KeyR', { shiftKey: true });
    expect(c.angle).toBeCloseTo(Math.PI / 12);
    c.setTool('road');
    expect(c.angle).toBe(0);
  });
});

describe('«🅿️ Площадка» (в «Станции»)', { timeout: 120_000 }, () => {
  it('клик у улицы ставит площадку и выбирает её; ручка угла — шире; клик по краю у улицы — ворота; Ctrl+Z — назад', () => {
    const game = freshGame({ ...NEW_GAME_SETTINGS, seed: 1, size: 'medium' });
    const { c, canvas, mouse, move, click, key } = play(game);
    c.setStationMode('lot');
    expect(c.action).toBe('lot');
    // Точка у улицы большого города, где площадка 6 × 2 встаёт без сноса, — подальше от перекрёстков: и вторые ворота
    // (дальше по краю, у площадки шире) не ближе LOT.corner к обрезу перекрёстка.
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    let p: Vec | null = null;
    for (const cor of game.roads.net.corridorsNear(town.center, town.radius).sort((a, b) => a.id - b.id)) {
      for (let s = 65; !p && s < cor.length - 65; s += 8) {
        const t = cor.lut.tangentAt(s);
        const q = add(cor.lut.pointAt(s), { x: -t.y * 25, y: t.x * 25 });
        const plan = game.lotPlan(q, { cols: c.lotCols, rows: c.lotRows });
        if (plan.ok && !plan.demolish.length) p = q;
      }
      if (p) break;
    }
    expect(p).not.toBeNull();
    // Предпросмотр у курсора: участок с местами и ручками, подпись — мест и цена.
    move(p!);
    const o = c.overlay();
    expect(o.lot?.ok).toBe(true);
    expect(o.lot?.stalls.length).toBe(12);
    expect(o.label?.text).toMatch(/🅿️ 12/);
    click(p!);
    expect(c.selection?.type).toBe('lot');
    const id = (c.selection as { id: number }).id;
    const cur = () => game.lotById(id)!.lot;
    expect(lotStallCount(cur())).toBe(12);
    // «Выбор»: ручка правого дальнего угла — тянем на два места вправо.
    c.setTool('select');
    c.select({ type: 'lot', id });
    const fp = cur().fp;
    const h = lotHandles(fp).find((x) => x.kind === 'corner' && x.side === 1)!;
    const to = add(h.pos, { x: Math.cos(fp.angle) * 2 * LOT.stall.w, y: Math.sin(fp.angle) * 2 * LOT.stall.w });
    move(h.pos);
    canvas.fire('mousedown', mouse(h.pos));
    move(to);
    win.fire('mouseup', mouse(to));
    expect(cur().fp.w).toBeCloseTo(lotWidth(8), 5);
    // Клик по краю у улицы мимо ворот — новые ворота ⬌.
    const g0 = cur().gates[0].x;
    const edge = lotGateDriveway(cur(), { x: g0 + (g0 > 0 ? -16 : 16) }).gate;
    click(edge);
    expect(cur().gates.length).toBe(2);
    // Ctrl+Z — ворота прочь, ещё раз — прежняя ширина.
    key('KeyZ', { ctrlKey: true });
    expect(cur().gates.length).toBe(1);
    key('KeyZ', { ctrlKey: true });
    expect(cur().fp.w).toBeCloseTo(lotWidth(6), 5);
  });
});
