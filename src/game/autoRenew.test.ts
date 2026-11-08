import { describe, expect, it } from 'vitest';
import { RENEW_GAP, type RenewCar, renewStep } from './autoRenew';
import { Game } from './game';
import { freightRoute, runSeconds, withoutCitizens } from './testkit';
import { type Line, MODELS, renewOn, vehicleCapacity } from './transport';

const car = (id: number, over: Partial<RenewCar> = {}): RenewCar => ({ id, capacity: 16, next: 24, free: true, load: 0, ...over });

describe('Шаг модернизации (renewStep)', () => {
  it('меняет свободную — самую незагруженную, а в пути не трогает', () => {
    const old = [car(1, { load: 10 }), car(2, { free: false }), car(3, { load: 4 })];
    expect(renewStep({ old, spare: 0, count: 3, min: 1, waited: false })).toEqual({ kind: 'replace', id: 3 });
    expect(renewStep({ old: [car(1, { free: false })], spare: 0, count: 1, min: 1, waited: false })).toBeNull();
  });

  it('запас вместимости на целую старую — продаёт пустую, а не меняет; не пустую — ждёт или, заждавшись, продаёт', () => {
    expect(renewStep({ old: [car(1), car(2, { load: 3 })], spare: 16, count: 3, min: 1, waited: false })).toEqual({ kind: 'sell', id: 1 });
    // Пустая — хоть и в пути порожняком; из пустых — лучше стоящую на станции.
    expect(renewStep({ old: [car(1, { free: false }), car(2, { load: 3 })], spare: 16, count: 3, min: 1, waited: false })).toEqual({ kind: 'sell', id: 1 });
    expect(renewStep({ old: [car(1, { free: false }), car(2)], spare: 16, count: 3, min: 1, waited: false })).toEqual({ kind: 'sell', id: 2 });
    expect(renewStep({ old: [car(2, { load: 3 })], spare: 16, count: 3, min: 1, waited: false })).toBeNull();
    expect(renewStep({ old: [car(2, { load: 3 })], spare: 16, count: 3, min: 1, waited: true })).toEqual({ kind: 'sell', id: 2 });
    // Запаса мало или машин и так минимум — меняет.
    expect(renewStep({ old: [car(1)], spare: 15, count: 3, min: 1, waited: false })).toEqual({ kind: 'replace', id: 1 });
    expect(renewStep({ old: [car(1)], spare: 16, count: 2, min: 2, waited: false })).toEqual({ kind: 'replace', id: 1 });
  });
});

/** Ферма → пищекомбинат по своей трассе, без машин жителей: n грузовиков и авто-парк от 1 до n. */
function truckLine(n = 3) {
  const game = withoutCitizens(new Game(7));
  const { built, line } = freightRoute(game);
  expect(built).toBe(true);
  for (let i = 0; i < n; i++) game.buyVehicle(line.id, 'truck');
  game.setLineAuto(line.id, { on: true, min: 1, max: n });
  runSeconds(game, 20);
  return { game, line };
}

const models = (game: Game, line: Line) => line.vehicles.map((id) => game.fleet.get(id)!.model);
const capacity = (game: Game, line: Line) => line.vehicles.reduce((s, id) => s + vehicleCapacity(game.fleet.get(id)!), 0);
const renews = (game: Game) => game.journal.entries.filter((e) => e.k === 'renew');

describe('Модернизация в авто-парке', { timeout: 30_000 }, () => {
  it('по одной, свободные на станции; вместительнее — машин меньше, а вместимость не меньше прежней', () => {
    const { game, line } = truckLine(3);
    expect(renewOn(line.auto)).toBe(true);
    // Новой модели нет — менять нечего.
    runSeconds(game, 30);
    expect(models(game, line)).toEqual(['truck', 'truck', 'truck']);
    const before = capacity(game, line);
    game.openModelTier(2);
    const at: number[] = [];
    let min = line.vehicles.length;
    let seen = 0;
    runSeconds(game, 240, () => {
      min = Math.min(min, line.vehicles.length);
      const list = renews(game);
      if (list.length === seen) return;
      // За такт — не больше одного шага; замена — машина стоит на станции.
      expect(list.length - seen).toBe(1);
      seen = list.length;
      at.push(game.time);
      const e = list[list.length - 1];
      if (!e.sell) expect(game.fleet.get(e.v as number)).toMatchObject({ model: 'truck2', state: 'loading' });
    });
    // Две замены (16 → 24 мест), третью старую продал: запас 2 · 8 мест покрыл её 16.
    expect(renews(game).map((e) => (e.sell ? 'sell' : e.model))).toEqual(['truck2', 'truck2', 'sell']);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(RENEW_GAP - 1e-6);
    expect(models(game, line)).toEqual(['truck2', 'truck2']);
    expect(capacity(game, line)).toBeGreaterThanOrEqual(before);
    expect(min).toBeGreaterThanOrEqual(2);
    // Закончил — заметка и запас забыт; докупать будет уже новую.
    expect(line.auto!.renewSpare).toBeUndefined();
    expect(game.journal.entries.some((e) => e.k === 'note' && String(e.text).includes('обновил транспорт'))).toBe(true);
    expect(game.autoModel(line)).toBe('truck2');
  });

  it('не хватает денег — ждёт и меняет, как только хватит; доплата — цена новой минус выручка за старую', () => {
    const { game, line } = truckLine(2);
    game.openModelTier(2);
    game.money = 1_000;
    runSeconds(game, 60);
    expect(models(game, line)).toEqual(['truck', 'truck']);
    const status = game.renewStatus(line);
    expect(status).toMatchObject({ to: 'truck2', funds: { ok: false } });
    expect(status.old).toHaveLength(2);
    game.money = 5_000_000;
    runSeconds(game, 30);
    expect(models(game, line).filter((m) => m === 'truck2')).toHaveLength(1);
    const replace = game.journal.entries.filter((e) => e.k === 'replace');
    expect(replace).toHaveLength(1);
    expect(replace[0].$).toBe(MODELS.truck2.price - Math.round(MODELS.truck.price * 0.6));
  });

  it('выключена игроком — не меняет и докупает прежнюю модель; включил снова — меняет', () => {
    const { game, line } = truckLine(2);
    game.setLineAuto(line.id, { renew: false });
    expect(line.auto!.renew).toBe(false);
    game.openModelTier(2);
    runSeconds(game, 90);
    expect(models(game, line)).toEqual(['truck', 'truck']);
    expect(game.autoModel(line)).toBe('truck');
    game.setLineAuto(line.id, { renew: true });
    expect(line.auto!.renew).toBeUndefined();
    expect(game.autoModel(line)).toBe('truck2');
    runSeconds(game, 30);
    expect(models(game, line)).toContain('truck2');
  });

  it('сохранение: в старом поля нет — включена; начатая модернизация продолжается после загрузки', () => {
    const { game, line } = truckLine(3);
    game.openModelTier(2);
    runSeconds(game, 120, () => {
      if (renews(game).length === 1) game.speed = 0;
    });
    expect(renews(game)).toHaveLength(1);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    expect(save.lines[0].auto).toMatchObject({ renewSpare: 8 });
    const loaded = withoutCitizens(new Game(game.settings, save));
    const l2 = loaded.lines.get(line.id)!;
    const from = renews(loaded).length;
    runSeconds(loaded, 240);
    // Вторая замена и продажа третьей — по запасу, сохранённому до загрузки (спрос потом может докупить уже новую).
    expect(renews(loaded).slice(from).map((e) => (e.sell ? 'sell' : e.model))).toEqual(['truck2', 'sell']);
    expect(models(loaded, l2)).not.toContain('truck');
    // Сохранение до модернизации: поля renew нет — включена, как по умолчанию.
    delete save.lines[0].auto.renew;
    delete save.lines[0].auto.renewSpare;
    delete save.lines[0].auto.renewAt;
    const old = withoutCitizens(new Game(game.settings, save));
    expect(renewOn(old.lines.get(line.id)!.auto)).toBe(true);
  });
});
