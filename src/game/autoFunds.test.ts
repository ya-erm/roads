import { describe, expect, it } from 'vitest';
import { autoFunds } from './autoFunds';

describe('Деньги авто-парка', () => {
  // Партия из задачи (журнал, Янв 1961): 103 машины, содержание $489 900 в месяц, выручка маршрутов за декабрь
  // $1 074 735, авто-парк хочет Фуру за $48 000 (её содержание — $5 700).
  const running = 489_900 + 5_700;
  const revenue = 1_074_735;

  it('счёт в плюсе, парк окупает себя — денег хватает (раньше требовал $337 900 и писал «не хватает»)', () => {
    const f = autoFunds({ money: 261_444, price: 48_000, running, revenue, monthLeft: 0.55 });
    expect(f).toMatchObject({ ok: true, reserve: 0, need: 48_000, short: 0, have: 261_444 });
  });

  it('сразу после списания содержания счёт в минусе — не хватает на саму машину', () => {
    const f = autoFunds({ money: -94_896, price: 48_000, running, revenue, monthLeft: 1 });
    expect(f).toMatchObject({ ok: false, reserve: 0, need: 48_000, short: 142_896 });
  });

  it('выручки нет — запас на весь месяц содержания', () => {
    const f = autoFunds({ money: 300_000, price: 48_000, running, revenue: 0, monthLeft: 1 });
    expect(f.reserve).toBe(running);
    expect(f.need).toBe(48_000 + running);
    expect(f.ok).toBe(false);
    expect(f.short).toBe(48_000 + running - 300_000);
  });

  it('выручка покрывает содержание не целиком — запас на непокрытое до конца месяца', () => {
    // Полмесяца осталось: придёт $60 000 из $120 000, содержание $100 000 — запас $40 000.
    const f = autoFunds({ money: 61_999, price: 22_000, running: 100_000, revenue: 120_000, monthLeft: 0.5 });
    expect(f).toMatchObject({ reserve: 40_000, need: 62_000, short: 1, ok: false });
    expect(autoFunds({ money: 62_000, price: 22_000, running: 100_000, revenue: 120_000, monthLeft: 0.5 }).ok).toBe(true);
  });

  it('ровно цена машины — хватает; на рубль меньше — нет', () => {
    expect(autoFunds({ money: 22_000, price: 22_000, running: 3_300, revenue: 50_000, monthLeft: 1 }).ok).toBe(true);
    expect(autoFunds({ money: 21_999, price: 22_000, running: 3_300, revenue: 50_000, monthLeft: 1 })).toMatchObject({ ok: false, short: 1 });
  });
});
