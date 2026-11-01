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
  /** Маршрут — список id связей (направленных половин сегментов). */
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
  /** Положение вдоль оси сегмента — нужно, чтобы перенести машину при разрезании дороги. */
  centerS: number;
  /** Визуальное боковое смещение при перестроении. */
  lateral: number;
  tripTime: number;
  stoppedTime: number;
  stuckTimer: number;
  rerouteTimer: number;
  lcCooldown: number;
}
