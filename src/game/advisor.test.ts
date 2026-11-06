import { describe, expect, it } from 'vitest';
import { ECONOMY, STATION } from '../config';
import { DEFAULT_SETTINGS } from '../world/settings';
import { advise, adviceOf, QUEUE_SECONDS, STUCK_SECONDS } from './advisor';
import { Game } from './game';
import { stationAtIndustry } from './testkit';

/** Песочница с маршрутом сырьё → ближайший завод: станции у обоих и грузовик. */
function setup() {
  const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
  game.money = 5_000_000;
  const plant = game.industries.find((i) => i.info.accepts.length === 1)!;
  const input = plant.info.accepts[0];
  const near = (a: { fp: { center: { x: number; y: number } } }) => Math.hypot(a.fp.center.x - plant.fp.center.x, a.fp.center.y - plant.fp.center.y);
  const raw = game.industries.filter((i) => i.info.produces === input).sort((a, b) => near(a) - near(b))[0];
  const a = stationAtIndustry(game, raw, plant.fp.center)!;
  const b = stationAtIndustry(game, plant, raw.fp.center)!;
  const line = game.createLine([a.id, b.id])!;
  const truck = game.buyVehicle(line.id, 'truck')!;
  return { game, raw, plant, input, a, b, line, truck };
}

const find = (game: Game, kind: string) => advise(game).filter((x) => x.kind === kind);

describe('Советник', () => {
  it('груз копится, а машин мало: совет купить машину; авто-парк упёрся в максимум — поднять максимум', () => {
    const { game, a, line, input } = setup();
    expect(find(game, 'waiting')).toHaveLength(0);
    a.cargo[input] = 200;
    const [w] = find(game, 'waiting');
    expect(w).toMatchObject({ level: 'warn', line: line.id, station: a.id, cargo: input, count: 200, fix: { kind: 'buy', line: line.id } });
    // Авто-парк может докупать сам — совета нет; упёрся в максимум — поднять максимум.
    game.setLineAuto(line.id, { on: true, min: 1, max: 4 });
    expect(find(game, 'waiting')).toHaveLength(0);
    game.setLineAuto(line.id, { max: 1 });
    expect(find(game, 'waiting')[0].fix).toEqual({ kind: 'autoMax', line: line.id });
  });

  it('авто-парку не хватает денег — сколько нужно и сколько есть, совет взять кредит; на грани банкротства — срочный совет', () => {
    const { game, line } = setup();
    game.setLineAuto(line.id, { on: true });
    line.auto!.noMoney = true;
    // Денег на счёте с запасом — покупка ждала их, но теперь хватает: совета нет (случай из задачи).
    expect(find(game, 'noMoney')).toHaveLength(0);
    // Выручки ещё не было — нужна цена грузовика и запас на месяц содержания двух грузовиков.
    game.money = 10_000;
    const [a] = find(game, 'noMoney');
    const f = game.autoFunds(line);
    expect(f).toMatchObject({ ok: false, price: 22_000, have: 10_000 });
    expect(f.reserve).toBeGreaterThan(0);
    expect(a).toMatchObject({ level: 'warn', line: line.id, fix: { kind: 'loan' }, funds: { have: 10_000, need: f.need } });
    expect(a.detail).toContain(`нужно $${f.need.toLocaleString('ru-RU')}`);
    expect(a.detail).toContain('на содержание транспорта в конце месяца');
    expect(a.detail).toContain('а на счёте $10');
    // Маршрут окупает содержание — запас не нужен, не хватает только на саму машину.
    line.revenueLast = 1_000_000;
    game.money = -5_000;
    const [b] = find(game, 'noMoney');
    expect(b.funds).toEqual({ have: -5_000, need: 22_000 });
    expect(b.detail).toMatch(/^«.+» ждёт машину: машина стоит \$22.000, а на счёте −\$5.000\. Кредит — ещё до/);
    game.money = 22_000;
    expect(find(game, 'noMoney')).toHaveLength(0);
    game.money = ECONOMY.creditLimit * 0.9;
    const list = advise(game);
    expect(list[0]).toMatchObject({ kind: 'debt', level: 'alert', fix: { kind: 'loan' } });
    // Кредит на пределе — брать нечего.
    game.loan = game.loanMax;
    expect(find(game, 'debt')[0].fix).toBeUndefined();
  });

  it('машины не могут выехать со станции дольше полуминуты — срочный совет у станции', () => {
    const { game, a, truck } = setup();
    truck.state = 'departing';
    truck.simId = null;
    truck.stop = 0;
    (game as unknown as { readyAt: Map<number, number> }).readyAt.set(truck.id, game.time - (STUCK_SECONDS + 10));
    expect(game.departWait(truck)).toBeCloseTo(STUCK_SECONDS + 10);
    expect(find(game, 'stuck')[0]).toMatchObject({ level: 'alert', station: a.id, count: 1, at: a.fp.center });
    // Уехал — совета нет.
    truck.state = 'driving';
    expect(find(game, 'stuck')).toHaveLength(0);
  });

  it('очередь на въезд — совет добавить пост; постов уже максимум — без кнопки', () => {
    const { game, b, line } = setup();
    const second = game.buyVehicle(line.id, 'truck')!;
    const waits = (game as unknown as { bayWaitSince: Map<number, number> }).bayWaitSince;
    for (const v of [line.vehicles.map((id) => game.fleet.get(id)!)[0], second]) {
      v.state = 'driving';
      v.stop = 1;
      v.simId = 999_000 + v.id;
      waits.set(v.id, game.time - (QUEUE_SECONDS + 5));
    }
    expect(find(game, 'queue')[0]).toMatchObject({ level: 'warn', station: b.id, count: 2, fix: { kind: 'bay', station: b.id } });
    b.bays = STATION.maxBays;
    expect(find(game, 'queue')[0].fix).toBeUndefined();
  });

  it('маршрут не работает, маршрут без машин, машины ездят полупустыми', () => {
    const { game, line, a, b } = setup();
    line.problem = 'Нет дороги: A → B';
    expect(find(game, 'noRoute')[0]).toMatchObject({ level: 'alert', line: line.id, station: line.stops[0] });
    line.problem = null;
    const empty = game.createLine([b.id, a.id])!;
    expect(find(game, 'noVehicles')[0]).toMatchObject({ level: 'tip', line: empty.id, fix: { kind: 'buy', line: empty.id } });
    game.buyVehicle(line.id, 'truck');
    line.loadLast = 0.1;
    expect(find(game, 'empty')[0]).toMatchObject({ level: 'tip', line: line.id, fix: { kind: 'sell', line: line.id } });
    expect(game.spareOf(line)).not.toBeNull();
  });

  it('продукцию завода не вывозит ни один маршрут; заводу на два сырья привезли одно', () => {
    const { game, plant } = setup();
    plant.producedLast = 50;
    // Маршрут только привозит сырьё на завод — его продукцию никто не забирает.
    expect(find(game, 'unsold')[0]).toMatchObject({ industry: plant.id, cargo: plant.info.produces, count: 50 });
    plant.producedLast = 0;
    expect(find(game, 'unsold')).toHaveLength(0);

    const two = game.industries.find((i) => i.info.accepts.length >= 2)!;
    expect(stationAtIndustry(game, two, { x: two.fp.center.x, y: two.fp.center.y - 500 })).not.toBeNull();
    const [have, lack] = two.info.accepts;
    two.stock[have] = 40;
    two.stock[lack] = 0;
    two.producedLast = 0;
    expect(find(game, 'missingInput')[0]).toMatchObject({ industry: two.id, cargo: lack });
    two.stock[lack] = 10;
    expect(find(game, 'missingInput')).toHaveLength(0);
  });

  it('срочные советы — первыми; для кадра советы пересчитываются не чаще раза в полсекунды', () => {
    const { game, a, line, input } = setup();
    a.cargo[input] = 200;
    line.problem = 'Нет дороги';
    const list = advise(game);
    expect(list.map((x) => x.level)).toEqual([...list.map((x) => x.level)].sort((p, q) => ['alert', 'warn', 'tip'].indexOf(p) - ['alert', 'warn', 'tip'].indexOf(q)));
    expect(list[0].kind).toBe('noRoute');
    const first = adviceOf(game);
    expect(adviceOf(game)).toBe(first);
    game.time += 1;
    expect(adviceOf(game)).not.toBe(first);
  });
});
