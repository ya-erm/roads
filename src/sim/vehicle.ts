import type { Vec } from '../core/vec';

export type VehicleKind = 'car' | 'truck' | 'bus';

export interface VehicleSpec {
  kind: VehicleKind;
  length: number;
  width: number;
  maxSpeed: number;
  accel: number;
  color: string;
  /** Цвет груза в кузове (для грузовиков). */
  load?: string;
}

export interface Vehicle extends VehicleSpec {
  id: number;
  targetNode: number;
  /** Маршрут — список id связей графа полос. */
  route: number[];
  routeIndex: number;
  /** Текущая полоса (на манёвре — полоса, с которой въехали). */
  lane: number;
  onMovement: string | null;
  granted: string | null;
  /** Манёвр, который машина собирается выполнить в ближайшем узле. */
  planned: string | null;
  waitingAt: number | null;
  requestTime: number;
  ready: boolean;
  s: number;
  v: number;
  pos: Vec;
  dir: Vec;
  /** Середина задней оси — кузов тянется за передней точкой по ней. */
  rear?: Vec;
  level: number;
  /** Слой отрисовки — как у полотна или узла под машиной: на пандусе моста она рисуется вместе с мостом, а не под ним. */
  layer?: number;
  /** Положение вдоль оси полотна — нужно, чтобы перенести машину при перестройке сети. */
  centerS: number;
  /** Визуальное боковое смещение при перестроении. */
  lateral: number;
  tripTime: number;
  stoppedTime: number;
  stuckTimer: number;
  rerouteTimer: number;
  lcCooldown: number;
  /** Ждёт окна для нужного перестроения (0…1 — насколько срочно): тогда чуть отстаёт от соседей. */
  mergeWait?: number;
  /** Остановиться, проехав ещё столько метров (автобус — центром напротив остановки); стоит, пока не отпустят. */
  holdDist?: number;
  /** Поворотник: −1 левый, 1 правый, 0 выключен. Считается в движении на каждом шаге, не сохраняется. */
  blinker?: Blinker;
  /**
   * Поворотник перестроения: куда машина собирается перестроиться или только что перестроилась (−1 влево,
   * 1 вправо, 0 — никуда), с какого времени движения он горит и — после перестроения — до какого.
   */
  laneSignal?: Blinker;
  laneSignalSince?: number;
  laneSignalUntil?: number;
}

/** Сторона поворотника: −1 левый, 1 правый, 0 выключен. */
export type Blinker = -1 | 0 | 1;

/** Что нужно, чтобы нарисовать машину: вид, цвет, нос и курс, поворотник. */
export type VehicleLook = Pick<Vehicle, 'kind' | 'length' | 'width' | 'color' | 'load' | 'pos' | 'dir' | 'blinker'>;
