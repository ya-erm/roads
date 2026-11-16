import { describe, expect, it } from 'vitest';
import { MODEL_UNLOCK } from '../config';
import { DEFAULT_SETTINGS } from '../world/settings';
import { Game, type SaveData } from './game';
import { freightRoute, freshGame, runSeconds, withoutCitizens } from './testkit';
import { type Line, MODELS, modelsFor } from './transport';
import { familyOf, legacyCarried, ModelUnlocks, unlockNeed } from './unlocks';

describe('Открытие моделей по объёму перевозок (ModelUnlocks)', () => {
  it('семейства: автобусы, грузовики (и автоцистерны — та же модель), грузовые и пассажирские поезда', () => {
    expect([familyOf('bus'), familyOf('bus2'), familyOf('bus3')]).toEqual(['bus', 'bus', 'bus']);
    expect([familyOf('truck'), familyOf('truck2'), familyOf('truck3')]).toEqual(['truck', 'truck', 'truck']);
    expect([familyOf('freightTrain'), familyOf('freightTrain2')]).toEqual(['freightRail', 'freightRail']);
    expect([familyOf('passengerTrain'), familyOf('passengerTrain2')]).toEqual(['paxRail', 'paxRail']);
    // Первое поколение открыто с начала; у каждой модели новее — свой порог, у III выше, чем у II.
    for (const id of ['truck', 'bus', 'freightTrain', 'passengerTrain'] as const) expect(unlockNeed(id)).toBe(0);
    expect(unlockNeed('truck3')).toBeGreaterThan(unlockNeed('truck2'));
    expect(unlockNeed('bus3')).toBeGreaterThan(unlockNeed('bus2'));
    for (const id of Object.keys(MODELS) as (keyof typeof MODELS)[]) expect(unlockNeed(id) > 0).toBe(MODELS[id].tier > 1);
  });

  it('порог открывает модель — один раз; III — только своим, бо́льшим порогом', () => {
    const u = new ModelUnlocks();
    expect(u.isOpen('bus')).toBe(true);
    expect(u.isOpen('bus2')).toBe(false);
    expect(u.add('bus', MODEL_UNLOCK.bus2 - 1)).toEqual([]);
    expect(u.progress('bus2')).toEqual({ family: 'bus', have: MODEL_UNLOCK.bus2 - 1, need: MODEL_UNLOCK.bus2, share: (MODEL_UNLOCK.bus2 - 1) / MODEL_UNLOCK.bus2 });
    expect(u.add('bus', 1)).toEqual(['bus2']);
    expect(u.isOpen('bus2')).toBe(true);
    expect(u.isOpen('bus3')).toBe(false);
    // Уже открытая — второй раз не «открывается»; счёт идёт и от машин новой модели.
    expect(u.add('bus2', MODEL_UNLOCK.bus3 - MODEL_UNLOCK.bus2 - 1)).toEqual([]);
    expect(u.add('bus2', 1)).toEqual(['bus3']);
    expect(u.add('bus3', 10_000)).toEqual([]);
  });

  it('счёт растёт только у своего семейства', () => {
    const u = new ModelUnlocks();
    u.add('truck', 5_000);
    u.add('freightTrain', 50);
    expect(u.carried).toEqual({ bus: 0, truck: 5_000, paxRail: 0, freightRail: 50 });
    expect(u.isOpen('truck3')).toBe(true);
    expect(u.isOpen('bus2')).toBe(false);
    expect(u.isOpen('freightTrain2')).toBe(false);
    expect(u.isOpen('passengerTrain2')).toBe(false);
    expect(u.add('bus', 0)).toEqual([]);
    expect(u.add('bus', -3)).toEqual([]);
    expect(u.carried.bus).toBe(0);
  });

  it('сохранение: счёт и открытые модели; открытое остаётся, даже если счёт ниже порога', () => {
    const u = new ModelUnlocks();
    u.add('bus', 700);
    u.unlock(['freightTrain2']);
    const back = new ModelUnlocks(JSON.parse(JSON.stringify(u.toSave())));
    expect(back.carried).toEqual(u.carried);
    expect(back.isOpen('bus2')).toBe(true);
    expect(back.isOpen('freightTrain2')).toBe(true);
    expect(back.isOpen('truck2')).toBe(false);
  });

  it('счёт старой партии: большее из журнала и оценки по доходу линии; семейство — по линии', () => {
    const lines = [
      // Журнал помнит 3 месяца по 40, текущий — 10; доход всего 9 000 при 50 ед. на 1 000 $ — оценка 450.
      { id: 1, family: 'truck' as const, revenueTotal: 9_000, revenueLast: 800, revenueMonth: 200, carriedLast: 40, carriedMonth: 10 },
      // Журнал полнее оценки (дохода мало) — берём журнал.
      { id: 2, family: 'bus' as const, revenueTotal: 100, revenueLast: 0, revenueMonth: 50, carriedLast: 0, carriedMonth: 5 },
      // Ничего не возила.
      { id: 3, family: 'paxRail' as const, revenueTotal: 0, revenueLast: 0, revenueMonth: 0, carriedLast: 0, carriedMonth: 0 },
    ];
    const months: [number, number][][] = [
      [
        [1, 40],
        [2, 30],
      ],
      [
        [1, 40],
        [2, 30],
      ],
      [[1, 40]],
    ];
    expect(legacyCarried(lines, months)).toEqual({ truck: 450, bus: 65, paxRail: 0, freightRail: 0 });
  });
});

/** Ферма → пищекомбинат по своей трассе, без машин жителей: два грузовика. */
function truckLine(trucks = 2) {
  const game = withoutCitizens(freshGame(7));
  const { built, line } = freightRoute(game);
  expect(built).toBe(true);
  for (let i = 0; i < trucks; i++) game.buyVehicle(line.id, 'truck');
  return { game, line };
}

/** Игра вперёд, пока линия не довезёт первый груз (не дольше limit секунд). */
function untilDelivered(game: Game, line: Line, limit = 240): void {
  const before = line.carriedMonth + line.carriedLast;
  for (let t = 0; t < limit && line.carriedMonth + line.carriedLast === before; t += 5) runSeconds(game, 5);
  expect(line.carriedMonth + line.carriedLast).toBeGreaterThan(before);
}

describe('Открытие моделей в партии', { timeout: 60_000 }, () => {
  it('новая партия — только первое поколение, в любом году; модели II не выходят по календарю', () => {
    const game = withoutCitizens(freshGame(7));
    expect(modelsFor('road', game.modelOpen)).toEqual(['truck', 'bus']);
    expect(modelsFor('rail', game.modelOpen)).toEqual(['freightTrain', 'passengerTrain']);
    (game as unknown as { month: number }).month = 30 * 12;
    expect(game.modelOpen('truck2')).toBe(false);
    expect(game.modelOpen('bus3')).toBe(false);
  });

  it('довезённый груз — в счёт грузовиков, и только их; дошёл до порога — Грузовик II в продаже, с заметкой и записью в журнале', () => {
    const { game, line } = truckLine();
    game.unlocks.carried.truck = MODEL_UNLOCK.truck2 - 1;
    expect(game.buyVehicle(line.id, 'truck2')).toBeNull();
    untilDelivered(game, line);
    expect(game.unlocks.carried.truck).toBe(MODEL_UNLOCK.truck2 - 1 + line.carriedMonth + line.carriedLast);
    expect(game.unlocks.carried).toMatchObject({ bus: 0, paxRail: 0, freightRail: 0 });
    expect(game.modelOpen('truck2')).toBe(true);
    expect(game.modelOpen('truck3')).toBe(false);
    expect(game.modelOpen('bus2')).toBe(false);
    expect(game.notices.some((n) => n.text.includes(`Открыт ${MODELS.truck2.name}`))).toBe(true);
    expect(game.journal.entries.find((e) => e.k === 'models')).toMatchObject({ open: ['truck2'] });
    expect(game.buyVehicle(line.id, 'truck2')).not.toBeNull();
  });

  it('авто-парк с модернизацией переходит на новую модель, как только она открылась', () => {
    const { game, line } = truckLine(2);
    game.setLineAuto(line.id, { on: true, min: 1, max: 2 });
    expect(game.autoModel(line)).toBe('truck');
    game.unlocks.carried.truck = MODEL_UNLOCK.truck2 - 1;
    untilDelivered(game, line);
    expect(game.autoModel(line)).toBe('truck2');
    // Меняет по одной, когда машина стоит на станции: ждём до трёх минут.
    const models = () => line.vehicles.map((id) => game.fleet.get(id)!.model);
    for (let s = 0; s < 180 && !models().includes('truck2'); s += 10) runSeconds(game, 10);
    expect(models()).toContain('truck2');
  });

  it('сохранение и загрузка: счёт и открытые модели те же', () => {
    const { game } = truckLine(0);
    game.unlocks.add('bus', MODEL_UNLOCK.bus2 + 12);
    game.unlocks.add('truck', 77);
    const save = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    expect(save.unlocks).toEqual({ carried: { bus: MODEL_UNLOCK.bus2 + 12, truck: 77, paxRail: 0, freightRail: 0 }, open: ['bus2'] });
    expect(save.modelTier).toBeUndefined();
    const loaded = new Game(save.settings, save);
    expect(loaded.unlocks.carried).toEqual(game.unlocks.carried);
    expect(loaded.modelOpen('bus2')).toBe(true);
    expect(loaded.modelOpen('truck2')).toBe(false);
  });

  it('сценарий: этап модели не открывает — только объём', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42, scenario: { difficulty: 'normal', challenge: false } });
    const sc = game.scenario!;
    const main = sc.state.objectives.filter((o) => o.phase === sc.state.phase && o.role === 'main').pop()!;
    main.status = 'done';
    expect(sc.advancePhase()).toBe(true);
    expect(game.modelOpen('truck2')).toBe(false);
    expect(game.modelOpen('bus2')).toBe(false);
    game.unlocks.add('bus', MODEL_UNLOCK.bus2);
    expect(game.modelOpen('bus2')).toBe(true);
  });
});

describe('Старые сохранения (без счёта перевозок)', { timeout: 60_000 }, () => {
  /** Сохранение партии как до счёта: без unlocks. */
  const legacy = (game: Game, patch: Partial<SaveData> = {}): SaveData => {
    const { unlocks: _drop, ...old } = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    return { ...old, ...patch };
  };

  it('открытое по прежнему календарю остаётся в продаже', () => {
    const { game } = truckLine(0);
    // Девятый год партии: Грузовик II (через 8 лет) вышел, Фура (через 17) — ещё нет.
    (game as unknown as { month: number }).month = 8 * 12 + 2;
    const loaded = new Game(game.settings, legacy(game));
    expect(loaded.modelOpen('truck2')).toBe(true);
    expect(loaded.modelOpen('truck3')).toBe(false);
    // Пересохранённая — уже со счётом, открытое сохраняется и после.
    const again = new Game(loaded.settings, JSON.parse(JSON.stringify(loaded.toSave())));
    expect(again.modelOpen('truck2')).toBe(true);
  });

  it('открытое ступенью сценария (modelTier, а совсем старое — по этапу) остаётся в продаже', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42, scenario: { difficulty: 'normal', challenge: false } });
    const tier3 = new Game(game.settings, legacy(game, { modelTier: 3 }));
    for (const id of ['truck2', 'bus2', 'freightTrain2', 'truck3', 'bus3', 'passengerTrain2'] as const) expect(tier3.modelOpen(id)).toBe(true);
    const save = legacy(game);
    save.scenario!.phase = 1;
    const phaseB = new Game(save.settings, save);
    for (const id of ['truck2', 'bus2', 'freightTrain2'] as const) expect(phaseB.modelOpen(id)).toBe(true);
    expect(phaseB.modelOpen('truck3')).toBe(false);
  });

  it('счёт восстанавливается по журналу и доходу нынешних линий; дошёл до порога — модель открывается при загрузке', () => {
    const { game, line } = truckLine(2);
    untilDelivered(game, line);
    const done = line.carriedMonth + line.carriedLast;
    const loaded = new Game(game.settings, legacy(game));
    expect(loaded.unlocks.carried.truck).toBeGreaterThanOrEqual(done);
    expect(loaded.unlocks.carried.bus).toBe(0);
    // Доход линии с начала — как будто возила гораздо дольше: оценка по доходу больше журнала.
    const save = legacy(game);
    const l = save.lines.find((x) => x.id === line.id)!;
    l.revenueTotal = ((l.revenueLast + l.revenueMonth) * MODEL_UNLOCK.truck2 * 2) / (l.carriedLast + l.carriedMonth);
    const rich = new Game(save.settings, save);
    expect(rich.unlocks.carried.truck).toBeGreaterThanOrEqual(MODEL_UNLOCK.truck2 * 2 - 1);
    expect(rich.modelOpen('truck2')).toBe(true);
    expect(rich.notices.some((n) => n.text.includes(`Открыт ${MODELS.truck2.name}`))).toBe(true);
  });
});
