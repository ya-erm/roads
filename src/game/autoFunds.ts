/**
 * Хватит ли авто-парку денег на машину. Авто-парк покупает только на свои — в минус счёт не уводит — и держит
 * запас на содержание транспорта, которое спишется в конце месяца, но лишь ту его часть, что не покроет выручка
 * маршрутов до тех пор (по выручке прошлого месяца). Парк окупает себя — запас не нужен, хватает цены машины.
 */
export interface AutoFundsInput {
  /** На счёте. */
  money: number;
  /** Цена машины, которую авто-парк хочет купить. */
  price: number;
  /** Содержание всего транспорта за месяц вместе с этой машиной — спишется в конце месяца. */
  running: number;
  /** Выручка маршрутов за прошлый месяц. */
  revenue: number;
  /** Сколько месяца осталось до списания содержания: 1 — месяц только начался, 0 — кончается. */
  monthLeft: number;
}

export interface AutoFunds {
  /** Сколько нужно на счёте: цена машины и запас. */
  need: number;
  /** Сколько на счёте. */
  have: number;
  price: number;
  /** Запас на содержание в конце месяца, которое не покроет выручка (0 — парк окупает себя). */
  reserve: number;
  /** Не хватает до need (0 — хватает). */
  short: number;
  ok: boolean;
}

export function autoFunds({ money, price, running, revenue, monthLeft }: AutoFundsInput): AutoFunds {
  const left = Math.min(1, Math.max(0, monthLeft));
  const reserve = Math.max(0, Math.round(running - Math.max(0, revenue) * left));
  const need = price + reserve;
  const short = Math.max(0, Math.ceil(need - money));
  return { need, have: money, price, reserve, short, ok: short === 0 };
}
