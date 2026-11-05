import type { Station } from '../world/entities';

/**
 * Маршруты города: заходят хотя бы на одну станцию или остановку, в охват которой попадают его дома
 * (Station.townIds — по ним же станция собирает жителей города и принимает грузы для него).
 * Порядок маршрутов — как во входном списке.
 */
export function linesForTown<L extends { stops: readonly number[] }>(
  lines: Iterable<L>,
  stations: Iterable<Pick<Station, 'id' | 'townIds'>>,
  townId: number,
): L[] {
  const own = new Set<number>();
  for (const st of stations) if (st.townIds.includes(townId)) own.add(st.id);
  if (!own.size) return [];
  return [...lines].filter((l) => l.stops.some((id) => own.has(id)));
}
