import type { Vec } from '../core/vec';
import type { ParkKind, Town, TownPark } from './entities';
import { type Footprint, FootprintIndex } from './spatial';

/** Название и значок вида зелени: подпись под курсором и заголовок карточки (ui/parkCard.ts). */
export const PARK_INFO: Record<ParkKind, { name: string; icon: string }> = {
  park: { name: 'Парк', icon: '🌳' },
  square: { name: 'Сквер', icon: '🌿' },
  plaza: { name: 'Площадь', icon: '🏛' },
  memorial: { name: 'Сквер с памятником', icon: '🎖' },
  embankment: { name: 'Набережная', icon: '🌊' },
};

/** Парк в сетке выбора: сам парк и его город. */
export interface ParkEntry {
  fp: Footprint;
  park: TownPark;
  town: Town;
}

/**
 * Парки, скверы, площади и набережные всех городов (Town.parks, townParks.ts) — для выбора мышью: сетка по участкам
 * (FootprintIndex), а не перебор всех парков мира на каждое движение мыши. Пересобирается, только когда сменился
 * список городов или у какого-нибудь города — список парков (новый массив или новые парки: placeParks дописывает в
 * тот же); проверка — по ссылкам и длинам, раз на запрос, без обхода самих парков.
 */
export class ParkIndex {
  private grid = new FootprintIndex<ParkEntry>(120);
  private byId = new Map<number, ParkEntry>();
  private towns: readonly Town[] | null = null;
  private lists: (readonly TownPark[] | undefined)[] = [];
  private sizes: number[] = [];

  private sync(towns: readonly Town[]): void {
    if (this.towns === towns && this.lists.length === towns.length) {
      let same = true;
      for (let i = 0; i < towns.length && same; i++) same = this.lists[i] === towns[i].parks && this.sizes[i] === (towns[i].parks?.length ?? 0);
      if (same) return;
    }
    this.towns = towns;
    this.lists = towns.map((t) => t.parks);
    this.sizes = towns.map((t) => t.parks?.length ?? 0);
    this.grid = new FootprintIndex<ParkEntry>(120);
    this.byId.clear();
    for (const town of towns) {
      for (const park of town.parks ?? []) {
        const e = { fp: park.fp, park, town };
        this.grid.add(e);
        this.byId.set(park.id, e);
      }
    }
  }

  /** Парк под точкой (участок, расширенный на margin): из нескольких — тот, чья середина ближе. */
  at(towns: readonly Town[], p: Vec, margin = 0): ParkEntry | null {
    let best: ParkEntry | null = null;
    let bestD = Infinity;
    for (const e of this.near(towns, p, margin + 1)) {
      const dx = p.x - e.fp.center.x;
      const dy = p.y - e.fp.center.y;
      const c = Math.cos(e.fp.angle);
      const s = Math.sin(e.fp.angle);
      const u = dx * c + dy * s;
      const v = -dx * s + dy * c;
      if (Math.abs(u) > e.fp.w / 2 + margin || Math.abs(v) > e.fp.h / 2 + margin) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  near(towns: readonly Town[], p: Vec, radius: number): ParkEntry[] {
    this.sync(towns);
    return this.grid.near(p, radius);
  }

  /** Парк по id (TownPark.id — id города × 100 + номер). */
  get(towns: readonly Town[], id: number): ParkEntry | null {
    this.sync(towns);
    return this.byId.get(id) ?? null;
  }
}
