/**
 * Терпение пассажиров на остановке: кто ждёт автобус, а кто уходит пешком или едет иначе (Game.paxWalkOff).
 *
 * Пассажир готов ждать тем дольше, чем дальше ему ехать: на соседнюю остановку проще дойти пешком, в другой город —
 * только ждать. Ждёт он не автобус, а место в нём: сколько ждать, решает его место в очереди — сколько мест
 * в приходящих автобусах (их измеряем: автобус приходит забитым — мест мало) и как часто они ходят. Кто встал в хвост
 * и не успевает уехать за своё терпение, уходит; кто ждёт давно, стоит впереди и сядет в ближайший автобус — остаётся.
 * В ближайший подошедший автобус влезть готов каждый: если он его возьмёт, ждать стоит, даже если ходят редко.
 */
import type { Station } from '../world/entities';

export const PAX_WAIT = {
  /** Сколько секунд готов ждать пассажир, которому ехать совсем близко. */
  base: 40,
  /** И ещё столько секунд на каждый километр по прямой до станции назначения. */
  perKm: 120,
  /** Дольше не ждёт никто (≈ 20 месяцев игры: междугородний пассажир, ≈10 км). */
  max: 1200,
  /** Мест в приходящем автобусе считаем не меньше этой доли вместимости — даже если приходит забитым. */
  minSeats: 0.25,
  /** Лишние в хвосте очереди уходят за такое характерное время, секунд (не разом, а по нескольку). */
  leaveTime: 10,
  /** Вес нового замера свободных мест в приходящей машине (скользящее среднее). */
  seatsEma: 0.3,
};

/** Сколько секунд готов ждать пассажир, которому ехать distance метров по прямой. */
export function paxPatience(distance: number): number {
  return Math.min(PAX_WAIT.max, PAX_WAIT.base + (PAX_WAIT.perKm * Math.max(0, distance)) / 1000);
}

/**
 * До какого места в очереди к линии пассажир остаётся ждать: сколько человек увезут машины, что придут за его
 * терпение (seats мест в каждой, приходят раз в headway секунд), но не меньше одной машины — в ближайшую влезть
 * готов каждый.
 */
export function paxTolerance(seats: number, headway: number, patience: number): number {
  if (seats <= 0) return 0;
  if (!(headway > 0)) return seats;
  return seats * Math.max(1, patience / headway);
}

/**
 * Какая доля ждущих этого направления остаётся: очередь queue к линии, пассажир остаётся, если стоит не дальше
 * tolerance. Направления в очереди перемешаны, так что за пределом — та же доля каждого направления.
 */
export function paxStayShare(tolerance: number, queue: number): number {
  if (queue <= tolerance) return 1;
  return Math.max(0, tolerance / queue);
}

/** Сколько (дробно) из n ждущих уходит за dt секунд, если ждать остаются share из них. */
export function paxLeaving(n: number, share: number, dt: number): number {
  if (n <= 0 || share >= 1) return 0;
  return Math.min(n, (n * (1 - share) * dt) / PAX_WAIT.leaveTime);
}

/** Ушли, не дождавшись, с этой станции: за этот месяц или за прошлый — что больше (по направлениям — сумма). */
export function paxGone(st: Pick<Station, 'paxGone' | 'paxGoneLast'>): number {
  const sum = (r?: Record<number, number>) => Object.values(r ?? {}).reduce((s, n) => s + n, 0);
  return Math.max(sum(st.paxGone), sum(st.paxGoneLast));
}

/** Сколько ушло, не дождавшись, к станции dest: за этот месяц или за прошлый — что больше. */
export function paxGoneTo(st: Pick<Station, 'paxGone' | 'paxGoneLast'>, dest: number): number {
  return Math.max(st.paxGone?.[dest] ?? 0, st.paxGoneLast?.[dest] ?? 0);
}
