import type { LaneNet } from '../lanes/model';
import type { Game } from './game';
import type { NetEdit, RoadPlan } from './roadbuild';

/** Ид объекта для ключа кэша: после стройки сеть — новый объект. */
const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object): number => {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = nextId++));
  return id;
};

/**
 * Проект перемещения («Дорога → Двигать» с «Проектом»): правки — узел, перо, изгиб, примыкание тупика — копятся,
 * а дорога остаётся как есть. План — все правки по порядку на копии сети тем же строителем дорог, что и обычный
 * перенос (те же проверки и цена: разница с тем, что построено сейчас). Следующую правку тянут уже от сети с
 * проектом; «Построить» — всё разом, одним шагом для Ctrl+Z.
 *
 * Тот же проект — и у «Полосы»: правки — новые полосы, съезды, въезды (opts: shove — дома у расширенной
 * дороги не сносим, а после стройки отодвигаем, как у обычной полосы).
 */
export class MoveProject {
  /** Правки по порядку: каждая — от сети с предыдущими. */
  edits: NetEdit[] = [];
  /** Растёт с каждой правкой: ключ кэша плана. */
  private version = 0;
  private cache: { key: string; plan: RoadPlan } | null = null;
  private baseCache: { key: string; net: LaneNet | null } | null = null;

  constructor(
    private readonly game: () => Game,
    private readonly opts: {
      /** Расширение дороги: дома не сносим — отодвинем после стройки (roadWidened). */
      shove?: boolean;
      /** Как назовёт стройку Ctrl+Z. */
      label?: string;
      /**
       * Общий проект дорог: после правок построенных дорог — новые участки проекта строительства (правка и ключ
       * для кэша); null — участков нет.
       */
      tail?: () => { edit: NetEdit; key: string } | null;
      /** Построили — у проекта строительства тоже всё построено. */
      built?: () => void;
    } = {},
  ) {}

  /** Меняется с каждой правкой: ключ для кэшей снаружи. */
  get stamp(): number {
    return this.version;
  }

  /** Среди правок есть расширение дороги («Полоса»): дома у изменённых дорог отодвигаются, а не сносятся. */
  get shove(): boolean {
    return this.shoves(this.edits);
  }

  /** Есть что строить: правки построенных дорог или участки общего проекта. */
  get hasWork(): boolean {
    return this.edits.length > 0 || !!this.opts.tail?.();
  }

  /** Правки «Полосы» (расширение дороги): дома у неё не сносим, а отодвигаем после стройки. */
  private readonly shoving = new WeakSet<NetEdit>();

  /** В проекте есть расширение дороги (полоса, съезд) — дома у изменённых дорог отодвигаются, а не сносятся. */
  private shoves(list: NetEdit[]): boolean {
    return !!this.opts.shove || list.some((e) => this.shoving.has(e));
  }

  private lay(list: NetEdit[], tail: NetEdit | null): RoadPlan {
    return this.game().roadBuilder.plan(
      (n) => {
        for (const e of list) if (e(n) === false) return false;
        if (tail && tail(n) === false) return false;
        return list.length > 0 || !!tail;
      },
      { shove: this.shoves(list) },
    );
  }

  /**
   * Все правки (и ещё extra — протяжка, что идёт сейчас), а в общем проекте дорог — и новые участки, на копии
   * сети: цена, проверки, сеть с проектом.
   */
  plan(extra?: NetEdit): RoadPlan {
    const g = this.game();
    const tail = this.opts.tail?.() ?? null;
    if (extra) return this.lay([...this.edits, extra], tail?.edit ?? null);
    const key = `${this.version}|${idOf(g.roads.net)}.${g.roads.net.version}|${Math.floor(g.budget)}|${tail?.key ?? ''}`;
    if (this.cache?.key !== key) this.cache = { key, plan: this.lay(this.edits, tail?.edit ?? null) };
    return this.cache.plan;
  }

  /**
   * Построенные дороги с правками проекта (без новых участков) — от них тянут следующую правку и к ним примыкают
   * новые участки; правок нет (или сеть так уже не правится) — null.
   */
  net(): LaneNet | null {
    if (!this.edits.length) return null;
    const g = this.game();
    const key = `${this.version}|${idOf(g.roads.net)}.${g.roads.net.version}`;
    if (this.baseCache?.key !== key) this.baseCache = { key, net: this.lay(this.edits, null).net };
    return this.baseCache.net;
  }

  /**
   * Добавить правку. Так не выходит совсем (не правится сеть) — причина, а правка не добавляется; не проходит
   * проверку — добавляется (красным), её можно поправить следующей.
   */
  add(edit: NetEdit, shove = false): string | null {
    if (shove) this.shoving.add(edit);
    const plan = this.lay([...this.edits, edit], null);
    if (!plan.net) return plan.reason ?? 'Так не передвинуть';
    this.edits.push(edit);
    this.version++;
    return null;
  }

  /** Правки — какими были (Ctrl+Z в общем проекте дорог). */
  restore(edits: NetEdit[]): void {
    this.edits = [...edits];
    this.version++;
  }

  /** Ctrl+Z в проекте: последняя правка — прочь. */
  undo(): boolean {
    if (!this.edits.length) return false;
    this.edits.pop();
    this.version++;
    return true;
  }

  /** «Отменить»: проект перемещения — прочь, дорога как была. */
  clear(): void {
    this.edits = [];
    this.version++;
  }

  /** «Построить»: все правки разом (Ctrl+Z отменит). null — построено, иначе причина (тогда ничего не меняется). */
  build(): string | null {
    if (!this.hasWork) return 'Проект пуст';
    const g = this.game();
    const plan = this.plan();
    if (!plan.ok) return plan.reason ?? 'Так не передвинуть';
    g.checkpoint(this.opts.label ?? 'перенос дороги');
    g.roadBuilder.apply(plan);
    // Дома, на которые налезла расширенная дорога или съезд, отодвигаются — как после обычной полосы.
    if (this.shoves(this.edits)) for (const id of plan.changed) g.roadWidened(id);
    g.commit();
    this.clear();
    this.opts.built?.();
    return null;
  }
}
