import { describe, expect, it } from 'vitest';
import { autoFunds } from './autoFunds';

describe('Деньги авто-парка', () => {
  // Партия из задачи (журнал, Янв 1961): 103 машины, содержание $489 900 в месяц, выручка маршрутов за декабрь
  // $1 074 735, авто-парк хочет Фуру за $48 000 (её содержание — $5 700).
  const running = 489_900 + 5_700;
  const revenue = 1_074_735;
  /** Запас — на полмесяца вперёд (ECONOMY.upkeepReserve): содержание списывается непрерывно. */
  const window = 0.5;

  it('счёт в плюсе, парк окупает себя — денег хватает (раньше требовал $337 900 и писал «не хватает»)', () => {
    const f = autoFunds({ money: 261_444, price: 48_000, running, revenue, window });
    expect(f).toMatchObject({ ok: true, reserve: 0, need: 48_000, short: 0, have: 261_444 });
  });

  it('счёт в минусе — не хватает на саму машину', () => {
    const f = autoFunds({ money: -94_896, price: 48_000, running, revenue, window });
    expect(f).toMatchObject({ ok: false, reserve: 0, need: 48_000, short: 142_896 });
  });

  it('выручки нет — запас на полмесяца содержания', () => {
    const f = autoFunds({ money: 250_000, price: 48_000, running, revenue: 0, window });
    expect(f.reserve).toBe(running / 2);
    expect(f.need).toBe(48_000 + running / 2);
    expect(f.ok).toBe(false);
    expect(f.short).toBe(48_000 + running / 2 - 250_000);
  });

  it('выручка покрывает содержание не целиком — запас на непокрытое за окно', () => {
    // Содержание $160 000 в месяц, выручка $120 000: непокрыто $40 000 в месяц, за полмесяца — $20 000.
    const f = autoFunds({ money: 41_999, price: 22_000, running: 160_000, revenue: 120_000, window });
    expect(f).toMatchObject({ reserve: 20_000, need: 42_000, short: 1, ok: false });
    expect(autoFunds({ money: 42_000, price: 22_000, running: 160_000, revenue: 120_000, window }).ok).toBe(true);
  });

  it('ровно цена машины — хватает; на рубль меньше — нет', () => {
    expect(autoFunds({ money: 22_000, price: 22_000, running: 3_300, revenue: 50_000, window }).ok).toBe(true);
    expect(autoFunds({ money: 21_999, price: 22_000, running: 3_300, revenue: 50_000, window })).toMatchObject({ ok: false, short: 1 });
  });
});
