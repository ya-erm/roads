import { describe, expect, it } from 'vitest';
import { addPhase, movePhase, phaseToggle, removePhase, specOf, toggleTurn, withLeftArrows } from '../lanes/lights';
import { renameArm } from '../lanes/model';
import { Game } from './game';
import { freshGame, withoutCitizens } from './testkit';

/** Перекрёсток на четыре дороги без светофора и кольца — со светофором. */
function lit() {
  const game = withoutCitizens(freshGame(7));
  game.money = 1_000_000;
  const net = game.roads.net;
  const n = [...net.nodes.values()].find(
    (x) => x.kind === 'junction' && (x.roundabout ?? null) === null && (x.control ?? 'none') === 'none' && net.ends(x).length === 4,
  )!;
  expect(game.toggleLights(n.id)).toBe(true);
  const info = () => game.junctionInfo(n.id)!;
  const turn = (fromIdx: number, kind: 'left' | 'straight' | 'right') => {
    const t = info().turns[fromIdx];
    return `${t.from}>${t.exits.find((e) => e.kind === kind)!.out}`;
  };
  return { game, n, info, turn };
}

describe('Фазы светофора в игре', { timeout: 30_000 }, () => {
  it('«Авто»: налево на общий зелёный — уступая встречным, конфликтов нет; правка начинается с них', () => {
    const { game, n, info } = lit();
    const auto = info();
    expect(auto.phasesCustom).toBe(false);
    expect(auto.phases).toHaveLength(2);
    for (const ph of auto.phases) {
      expect(ph.clashes).toEqual([]);
      // В каждой фазе встречные налево уступают: два левых поворота.
      expect(ph.yields).toHaveLength(2);
    }
    // Убрали левый поворот из первой фазы — фазы стали своими, остальное как было.
    const left = auto.phases[0].yields[0];
    game.editPhases(n.id, (s) => toggleTurn(s, 0, left));
    expect(info().phasesCustom).toBe(true);
    expect(info().phases[0].go).not.toContain(left);
    // Поворот, которого нет ни в одной фазе, — своя фаза «Авто» в конце: машины не стоят вечно.
    expect(info().phases).toHaveLength(3);
    expect(info().phases[2]).toMatchObject({ extra: true, go: [left] });
    game.resetPhases(n.id);
    expect(info().phasesCustom).toBe(false);
    expect(info().phases.map((p) => p.go)).toEqual(auto.phases.map((p) => p.go));
  });

  it('конфликт: поперечный поток в ту же фазу не дать; встречному налево — можно', () => {
    const { game, n, info } = lit();
    const [a, b] = info().phases;
    // Прямо с поперечной дороги — пересекает прямые фазы a.
    const crossStraight = b.go.find((k) => !b.yields.includes(k) && info().turns.some((t) => t.exits.some((e) => `${t.from}>${e.out}` === k && e.kind === 'straight')))!;
    expect(game.phaseClashes(n.id, a.go, crossStraight).length).toBeGreaterThan(0);
    // Левый поворот фазы a уже в ней — конфликта с ней нет (он уступает).
    expect(game.phaseClashes(n.id, a.go.filter((k) => k !== a.yields[0]), a.yields[0])).toEqual([]);
    // Если всё же задать такую фазу (например, старая настройка), карточка подсветит конфликт.
    game.editPhases(n.id, (s) => toggleTurn(s, 0, crossStraight));
    expect(info().phases[0].clashes).toContain(crossStraight);
  });

  it('стрелки налево: своя фаза для левых — на карте секция со стрелкой; фазы сохраняются в партии', () => {
    const { game, n, info } = lit();
    const lefts = info().phases.map((p) => p.yields);
    game.editPhases(n.id, (s) => withLeftArrows(s, lefts));
    const phases = info().phases;
    expect(phases).toHaveLength(4);
    expect(phases[0].go.sort()).toEqual([...lefts[0]].sort());
    expect(phases[0].yields).toEqual([]);
    const L = () => game.roads.graph.nodes.get(n.id)!.lights!;
    expect(L().heads.every((h) => h.arrows.length === 1 && h.arrows[0].kind === 'left')).toBe(true);
    // Порядок, длительность, добавить и убрать.
    game.editPhases(n.id, (s) => addPhase(movePhase(s, 0, 1), 12));
    expect(info().phases.map((p) => p.green)).toEqual([8, 6, 6, 8, 12]);
    game.editPhases(n.id, (s) => removePhase(s, 4));
    // Сохранение и загрузка: те же фазы; секции со стрелкой на месте.
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = withoutCitizens(new Game(game.settings, save));
    expect(loaded.roads.net.node(n.id).phases).toEqual(game.roads.net.node(n.id).phases);
    expect(loaded.junctionInfo(n.id)!.phases.map((p) => p.go)).toEqual(info().phases.map((p) => p.go));
    expect(loaded.roads.graph.nodes.get(n.id)!.lights!.heads.some((h) => h.arrows.length)).toBe(true);
  });

  it('старое сохранение без фаз — «Авто»; разрезали дорогу у перекрёстка — повороты фаз переименованы', () => {
    const { game, n, info } = lit();
    game.editPhases(n.id, (s) => toggleTurn(s, 0, info().phases[0].go[0]));
    const node = game.roads.net.node(n.id);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    // Узел в сохранении — где бы он ни лежал: убираем у него фазы, как в старой версии.
    const strip = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      const o = x as Record<string, unknown>;
      if (o.id === n.id && o.kind === 'junction' && 'phases' in o) delete o.phases;
      for (const v of Object.values(o)) strip(v);
    };
    strip(save);
    const old = withoutCitizens(new Game(game.settings, save));
    expect(old.junctionInfo(n.id)!.phasesCustom).toBe(false);
    expect(old.junctionInfo(n.id)!.phases).toHaveLength(2);
    // Переименование полотна (разрезали) — и в поворотах фаз.
    const arm = node.corridors[0];
    const copy = { ...node, phases: node.phases!.map((p) => ({ ...p, go: [...p.go] })) };
    renameArm(copy, arm, 999);
    expect(copy.phases.flatMap((p) => p.go).some((k) => k.split('>').includes(String(arm)))).toBe(false);
    expect(copy.phases.flatMap((p) => p.go).some((k) => k.split('>').includes('999'))).toBe(true);
  });

  it('правка фазы на карте: поперечный — нельзя, свой — снять; машины — по новой фазе; Ctrl+Z и сохранение', () => {
    const { game, n, info, turn } = lit();
    const L = () => game.roads.graph.nodes.get(n.id)!.lights!;
    const [a, b] = info().phases;
    // В фазе a поперечные прямые — «нельзя», с кем пересекутся — зелёные a.
    const states = game.phaseStates(n.id, 0)!;
    const cross = b.go.find((k) => states.get(k)!.look === 'blocked')!;
    expect(cross).toBeDefined();
    expect(states.get(cross)!.with.every((k) => a.go.includes(k))).toBe(true);
    expect(game.phaseStates(n.id, 9)).toBeNull();
    // Отказ: фазы не меняются.
    const refused = phaseToggle(specOf(L().phases), 0, cross, states);
    expect(refused.clash.length).toBeGreaterThan(0);
    // Снять зелёный прямому фазы a (как клик по проезду), со снимком для Ctrl+Z.
    const straight = a.go.find((k) => [0, 1, 2, 3].some((i) => k === turn(i, 'straight')))!;
    expect(straight).toBeDefined();
    game.checkpoint('фаза светофора');
    game.editPhases(n.id, (s) => phaseToggle(s, 0, straight, states).spec);
    game.commit();
    expect(info().phases[0].go).not.toContain(straight);
    // Машины едут по новой фазе: у прямого зелёного в фазе 0 больше нет — его манёвры не в ней.
    const g = game.roads.graph;
    const moves = (g.junctionMoves.get(n.id) ?? []).filter((m) => g.turnOf(m) === straight);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.some((m) => L().phases[0].moves.has(m.key))).toBe(false);
    // Он не попал ни в одну фазу — своя «Авто» в конце: стоять вечно не будет.
    expect(L().phases.some((p) => p.extra && p.go.includes(straight))).toBe(true);
    // Сохранение: та же правка.
    const loaded = withoutCitizens(new Game(game.settings, JSON.parse(JSON.stringify(game.toSave()))));
    expect(loaded.junctionInfo(n.id)!.phases[0].go).not.toContain(straight);
    // Ctrl+Z — как было («Авто»).
    expect(game.undo()).toBe('фаза светофора');
    expect(info().phasesCustom).toBe(false);
    expect(info().phases[0].go).toContain(straight);
  });
});
