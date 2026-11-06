/**
 * Кэш неподвижного на карте — плитками (src/render/renderer.ts рисует в них землю, дороги, дома и мосты, а в кадре
 * только копирует их и рисует поверх машины, светофоры, анимации и подсветку).
 *
 * Плитка — квадрат TILE_PX × TILE_PX пикселей холста (устройства) в мировых координатах уровня зума: ключ — зум
 * уровня и номер плитки (i, j). У плитки несколько слоёв по высоте (TileLayer): земля, под ней — тоннели, над ней —
 * мосты двух уровней; машины каждой высоты рисуются между ними.
 *
 * Уровень зума: пока камера стоит — ровно её зум (плитка ложится на экран пиксель в пиксель); при плавном зуме
 * старый уровень растягивается, а новый заводится, когда зум постоял SETTLE_MS или растяжение стало слишком
 * сильным (pickLevel). Пока новый уровень дорисовывается, недостающее берётся из прежнего (запасного).
 *
 * Сброс: что изменилось — рамками в мире (SceneDiff сравнивает слепки сети, зданий и прочего по подписям);
 * задетые плитки помечаются устаревшими и перерисовываются, пока видны старыми.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Сторона плитки в пикселях холста (устройства): плитка 512×512 — 1 МБ. */
export const TILE_PX = 512;
/**
 * Холст плитки шире её на столько пикселей с каждой стороны: что лежит у края плитки, рисуется целиком, не обрезанным
 * краем холста, — сглаживание краёв то же, что на экране (без шва), а при растяжении у краёв есть соседние пиксели.
 */
export const TILE_PAD = 32;
/** Сторона холста плитки. */
export const TILE_CANVAS = TILE_PX + 2 * TILE_PAD;

/**
 * Слои плитки снизу вверх: UNDER — земля с дорогами в тоннелях (есть, только если в плитке тоннели: тогда машины
 * в них рисуются между ним и GROUND), GROUND — земля, дороги, дома (без UNDER — непрозрачный, вместе с землёй),
 * дальше — мосты и эстакады уровня высоты 1 и 2 (только где они есть): слой уровня L — GROUND + L.
 */
export const UNDER = 0;
export const GROUND = 1;
export const LAYERS = 4;

/** Сколько мс зум должен простоять, чтобы плитки перерисовались точно под него. */
export const SETTLE_MS = 160;
/** Плавный зум растягивает старый уровень до стольких раз; дальше — новый уровень сразу. */
export const STRETCH_MAX = 1.5;
/** …и сжимает до стольких: мельче — плиток на экран слишком много. */
export const SHRINK_MAX = 1.35;

/** Мировой размер стороны плитки на зуме zoom и плотности пикселей dpr. */
export const tileWorld = (zoom: number, dpr: number): number => TILE_PX / (zoom * dpr);

/** Рамка плитки (i, j) в мире. */
export function tileBox(i: number, j: number, world: number): Box {
  return { x0: i * world, y0: j * world, x1: (i + 1) * world, y1: (j + 1) * world };
}

/** Номера плиток, задетых рамкой: i0..i1, j0..j1 включительно (касание края — тоже). */
export function tileRange(b: Box, world: number): { i0: number; i1: number; j0: number; j1: number } {
  return { i0: Math.floor(b.x0 / world), i1: Math.floor(b.x1 / world), j0: Math.floor(b.y0 / world), j1: Math.floor(b.y1 / world) };
}

export const grow = (b: Box, d: number): Box => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });

export const meets = (a: Box, b: Box): boolean => !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1);

export const unite = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

/**
 * Уровень зума плиток: level — нынешний (null — ещё нет), zoom — камеры, still — сколько мс зум не менялся.
 * Совпадает — он и остаётся; зум постоял — ровно под него; во время зума — прежний, пока растяжение в пределах.
 */
export function pickLevel(level: number | null, zoom: number, still: number): number {
  if (level === null || zoom === level || still >= SETTLE_MS) return zoom;
  const r = zoom / level;
  return r > STRETCH_MAX || r < 1 / SHRINK_MAX ? zoom : level;
}

/**
 * Где плитка уровня ложится на экран: левый верхний угол и сторона в пикселях холста. k — зум камеры × dpr,
 * tx, ty — сдвиг камеры в пикселях холста (уже целый). Свой уровень — ровно TILE_PX и целые координаты.
 */
export function tileRect(i: number, j: number, world: number, k: number, tx: number, ty: number): { x: number; y: number; size: number } {
  const size = world * k;
  if (Math.abs(size - TILE_PX) < 1e-6) return { x: Math.round(i * world * k + tx), y: Math.round(j * world * k + ty), size: TILE_PX };
  return { x: i * world * k + tx, y: j * world * k + ty, size };
}

/**
 * Слепок группы нарисованного (полотна, узлы, дома города…): id → подпись и рамка. update получает новый
 * список и отвечает рамками того, что появилось, пропало или поменяло подпись (у изменённого — старой и новой).
 */
export class SceneDiff<K = number> {
  private items = new Map<K, { sig: string; box: Box; seen: number }>();
  private gen = 0;

  get size(): number {
    return this.items.size;
  }

  /** Новый слепок: each перечисляет объекты через add(id, подпись, рамка). Ответ — рамки изменений. */
  update(each: (add: (id: K, sig: string, box: Box) => void) => void): Box[] {
    const gen = ++this.gen;
    const out: Box[] = [];
    each((id, sig, box) => {
      const old = this.items.get(id);
      if (!old) {
        this.items.set(id, { sig, box, seen: gen });
        out.push(box);
        return;
      }
      if (old.sig !== sig) {
        out.push(old.box, box);
        old.sig = sig;
        old.box = box;
      }
      old.seen = gen;
    });
    for (const [id, it] of this.items) {
      if (it.seen === gen) continue;
      out.push(it.box);
      this.items.delete(id);
    }
    return out;
  }

  clear(): void {
    this.items.clear();
  }
}

/** Холст плитки: непрозрачный (земля) или прозрачный (слой поверх) — запас у них раздельный. */
export interface TileCanvas {
  readonly opaque: boolean;
}

export interface Tile<C> {
  i: number;
  j: number;
  /** Холсты слоёв (UNDER, GROUND, мосты); null — этого слоя в плитке нет. */
  layers: (C | null)[];
  /** Нарисована хотя бы раз: её можно показывать, даже устаревшую. */
  ready: boolean;
  /** Устарела: что-то в ней поменялось — перерисовать. */
  dirty: boolean;
  /** Номер кадра, когда была нужна (вытесняются давно не нужные). */
  used: number;
}

export interface TileSet<C> {
  zoom: number;
  dpr: number;
  /** Мировой размер стороны плитки. */
  world: number;
  tiles: Map<string, Tile<C>>;
}

/** Что делать с плиткой в этом кадре: must — рисовать сейчас (иначе дыра), dirty — устарела, ahead — про запас. */
export interface TileJob<C> {
  tile: Tile<C>;
  must: boolean;
  dirty: boolean;
  ahead: boolean;
}

/** Порядок работы: сначала дыры, потом устаревшие на экране, потом недорисованные уровня, потом про запас. */
export function jobRank(j: { must: boolean; dirty: boolean; ahead: boolean }): number {
  return j.must ? 0 : j.ahead ? 3 : j.dirty ? 1 : 2;
}

/**
 * Плитки по уровням зума: текущий (sets[0]) и запасной (прежний, пока текущий не готов). Холсты — снаружи
 * (make), освободившиеся идут в запас и выдаются снова: release/take.
 */
export class TileCache<C extends TileCanvas> {
  /** [0] — текущий уровень, дальше — запасной. */
  sets: TileSet<C>[] = [];
  /** Номер кадра (frame растит). */
  frameNo = 0;
  private lastZoom = Number.NaN;
  private zoomSince = 0;
  private free: C[] = [];

  constructor(private readonly make: (opaque: boolean) => C) {}

  /** Новый кадр: уровень под зум камеры (новый, если пора). now — время, мс. */
  frame(zoom: number, dpr: number, now: number): TileSet<C> {
    this.frameNo++;
    if (zoom !== this.lastZoom) {
      this.lastZoom = zoom;
      this.zoomSince = now;
    }
    let cur: TileSet<C> | undefined = this.sets[0];
    if (cur && cur.dpr !== dpr) {
      this.clear();
      cur = undefined;
    }
    const want = pickLevel(cur?.zoom ?? null, zoom, now - this.zoomSince);
    if (!cur || want !== cur.zoom) {
      // Прежний уровень — запасным; ещё один, старше, — на случай, если прежний не успел дорисоваться (быстрый зум).
      for (const old of this.sets.slice(2)) this.drop(old);
      const next: TileSet<C> = { zoom: want, dpr, world: tileWorld(want, dpr), tiles: new Map() };
      this.sets = cur ? [next, ...this.sets.slice(0, 2)] : [next];
    }
    return this.sets[0];
  }

  /** Плитка уровня (новая — пустая, не готова). */
  tile(set: TileSet<C>, i: number, j: number): Tile<C> {
    const key = `${i}:${j}`;
    let t = set.tiles.get(key);
    if (!t) {
      t = { i, j, layers: new Array<C | null>(LAYERS).fill(null), ready: false, dirty: false, used: 0 };
      set.tiles.set(key, t);
    }
    t.used = this.frameNo;
    return t;
  }

  /** Плитки уровня, задетые рамкой box (мир), по рядам. */
  cover(set: TileSet<C>, box: Box): Tile<C>[] {
    const r = tileRange(box, set.world);
    const out: Tile<C>[] = [];
    for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) out.push(this.tile(set, i, j));
    return out;
  }

  /** Готовые плитки уровня в рамке box — без создания новых. */
  readyIn(set: TileSet<C>, box: Box): Tile<C>[] {
    const r = tileRange(box, set.world);
    const out: Tile<C>[] = [];
    for (let j = r.j0; j <= r.j1; j++) {
      for (let i = r.i0; i <= r.i1; i++) {
        const t = set.tiles.get(`${i}:${j}`);
        if (t?.ready) {
          t.used = this.frameNo;
          out.push(t);
        }
      }
    }
    return out;
  }

  /** Закрывают ли рамку box (мир) целиком готовые плитки одного из запасных уровней. */
  backed(box: Box): boolean {
    return this.sets.slice(1).some((fb) => {
      // Чуть внутрь: плитка, только касающаяся края, не нужна.
      const r = tileRange(grow(box, -fb.world * 1e-6), fb.world);
      for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) if (!fb.tiles.get(`${i}:${j}`)?.ready) return false;
      return true;
    });
  }

  /**
   * Работа на кадр: need — плитки на экране, ahead — вокруг (про запас), по порядку jobRank. Дыра — плитки на
   * экране ещё нет, а запасной уровень её место не закрывает.
   */
  jobs(set: TileSet<C>, screen: Box, around: Box): TileJob<C>[] {
    const need = this.cover(set, screen);
    const seen = new Set(need);
    const out: TileJob<C>[] = [];
    for (const t of need) {
      if (t.ready && !t.dirty) continue;
      const must = !t.ready && !this.backed(tileBox(t.i, t.j, set.world));
      out.push({ tile: t, must, dirty: t.ready, ahead: false });
    }
    for (const t of this.cover(set, around)) {
      if (seen.has(t) || (t.ready && !t.dirty)) continue;
      out.push({ tile: t, must: false, dirty: t.ready, ahead: true });
    }
    return out.sort((a, b) => jobRank(a) - jobRank(b));
  }

  /** Пометить устаревшими плитки всех уровней, задетые рамками. Ответ — сколько плиток задето. */
  invalidate(boxes: readonly Box[]): number {
    let n = 0;
    if (!boxes.length) return 0;
    for (const set of this.sets) {
      for (const t of set.tiles.values()) {
        if (!t.ready || t.dirty) continue;
        const tb = tileBox(t.i, t.j, set.world);
        for (const b of boxes) {
          if (meets(tb, b)) {
            t.dirty = true;
            n++;
            break;
          }
        }
      }
    }
    return n;
  }

  /** Все плитки устарели (сменились настройки вида и т. п.): перерисуются, а пока видны старыми. */
  invalidateAll(): void {
    for (const set of this.sets) for (const t of set.tiles.values()) if (t.ready) t.dirty = true;
  }

  /** Холст из запаса или новый. */
  take(opaque: boolean): C {
    const k = this.free.findIndex((c) => c.opaque === opaque);
    return k >= 0 ? this.free.splice(k, 1)[0] : this.make(opaque);
  }

  /** Холст слоя layer плитки: нужен — тот же, если подходит, или из запаса; не нужен (opaque null) — в запас. */
  layer(t: Tile<C>, layer: number, opaque: boolean | null): C | null {
    const had = t.layers[layer];
    if (had && opaque !== null && had.opaque === opaque) return had;
    if (had) this.release(had);
    t.layers[layer] = opaque === null ? null : this.take(opaque);
    return t.layers[layer];
  }

  /** Холст больше не нужен этой плитке — в запас. */
  release(c: C): void {
    this.free.push(c);
  }

  /** Сколько холстов занято плитками. */
  get canvases(): number {
    let n = 0;
    for (const set of this.sets) for (const t of set.tiles.values()) for (const c of t.layers) if (c) n++;
    return n;
  }

  /** Запасной уровень больше не нужен: текущий закрыл экран. */
  dropFallback(): void {
    for (const old of this.sets.slice(1)) this.drop(old);
    this.sets.length = Math.min(this.sets.length, 1);
  }

  /**
   * Вытеснение: плиток больше limit — убираются давно не нужные (не в этом кадре), холсты — в запас.
   * Запас холстов — не больше spare.
   */
  trim(limit: number, spare = 8): void {
    const all: [TileSet<C>, string, Tile<C>][] = [];
    for (const set of this.sets) for (const [k, t] of set.tiles) all.push([set, k, t]);
    if (all.length > limit) {
      all.sort((a, b) => a[2].used - b[2].used);
      for (const [set, k, t] of all.slice(0, all.length - limit)) {
        if (t.used === this.frameNo) break;
        this.dropTile(set, k, t);
      }
    }
    if (this.free.length > spare) this.free.length = spare;
  }

  /** Всё заново (новая карта, выключили кэш). */
  clear(): void {
    for (const set of this.sets) this.drop(set);
    this.sets = [];
    this.free = [];
  }

  private dropTile(set: TileSet<C>, key: string, t: Tile<C>): void {
    for (const c of t.layers) if (c) this.release(c);
    t.layers.fill(null);
    set.tiles.delete(key);
  }

  private drop(set: TileSet<C>): void {
    for (const [k, t] of [...set.tiles]) this.dropTile(set, k, t);
  }
}
