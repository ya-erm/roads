import type { Game } from '../game/game';
import type { TrafficActivity } from '../lanes/traffic';
import type { Vehicle } from '../sim/vehicle';
import { SERVICES } from '../game/services';

const TEXT: Record<TrafficActivity['kind'], string> = {
  driving: 'Едет',
  crossing: 'Проезжает перекрёсток',
  junction: 'Подъезжает к перекрёстку',
  following: 'Ждёт машину впереди',
  light: 'Ждёт разрешающего сигнала светофора',
  yield: 'Уступает дорогу',
  exit: 'Ждёт свободного места за перекрёстком',
  pedestrians: 'Пропускает пешеходов',
  barrier: 'Ждёт открытия переезда',
  turn: 'Ждёт завершения поворота через встречную полосу',
  merge: 'Ждёт возможности перестроиться',
  arrival: 'Подъезжает к цели',
  stop: 'Стоит у места остановки',
  parking: 'Выполняет парковочный манёвр',
  'parking-space': 'Ждёт свободного места на парковке',
};

/** Причина из симуляции и переход к конкретной машине, которую она ждёт. */
export function trafficActivityHtml(game: Game, sim: Vehicle): string {
  const activity = game.garages.activity(sim) ?? game.traffic.activity(sim);
  const other = activity.vehicle !== undefined ? game.traffic.vehicles.get(activity.vehicle) : undefined;
  const service = other && game.serviceOfSim(other.id);
  const name = service ? SERVICES[service].name : other?.kind === 'bus' ? 'Автобус' : other?.kind === 'truck' ? 'Грузовик' : 'Машина';
  const link = other ? ` <button class="place-link" data-action="show-traffic-vehicle" data-id="${other.id}" title="Показать машину и открыть её карточку">${name} №${other.id} →</button>` : '';
  const text = activity.kind === 'following' && sim.v > 1 ? 'Едет за машиной впереди' : TEXT[activity.kind];
  return `<span>Действие</span><b>${text}${link}</b>`;
}
