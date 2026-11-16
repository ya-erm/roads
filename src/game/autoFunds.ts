/**
 * Хватит ли авто-парку денег на машину. Авто-парк покупает только на свои — в минус счёт не уводит — и держит
 * запас на содержание транспорта: оно списывается непрерывно (Game.accrueUpkeep), запас — на ближайшее окно
 * (window — доля месяца, ECONOMY.upkeepReserve: полмесяца), но лишь та часть, что не покроет выручка маршрутов
 * за это окно (по выручке прошлого месяца). Парк окупает себя — запас не нужен, хватает цены машины.
 */
export interface AutoFundsInput {
  /** На счёте. */
  money: number;
  /** Цена машины, которую авто-парк хочет купить. */
  price: number;
  /** Содержание всего транспорта в месяц вместе с этой машиной. */
  running: number;
  /** Выручка маршрутов за прошлый месяц. */
  revenue: number;
  /** На какую долю месяца вперёд держать запас: 0.5 — на полмесяца. */
  window: number;
}

export interface AutoFunds {
  /** Сколько нужно на счёте: цена машины и запас. */
  need: number;
  /** Сколько на счёте. */
  have: number;
  price: number;
  /** Запас на содержание за окно, которое не покроет выручка (0 — парк окупает себя). */
  reserve: number;
  /** Не хватает до need (0 — хватает). */
  short: number;
  ok: boolean;
}

export function autoFunds({ money, price, running, revenue, window }: AutoFundsInput): AutoFunds {
  const share = Math.max(0, window);
  const reserve = Math.max(0, Math.round((running - Math.max(0, revenue)) * share));
  const need = price + reserve;
  const short = Math.max(0, Math.ceil(need - money));
  return { need, have: money, price, reserve, short, ok: short === 0 };
}
