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

  constructor(
    private readonly game: () => Game,
    private readonly opts: {
      /** Расширение дороги: дома не сносим — отодвинем после стройки (roadWidened). */
      shove?: boolean;
      /** Как назовёт стройку Ctrl+Z. */
      label?: string;
    } = {},
  ) {}

  /** Все правки (и ещё extra — протяжка, что идёт сейчас) на копии сети: цена, проверки, сеть с проектом. */
  plan(extra?: NetEdit): RoadPlan {
    const g = this.game();
    const list = extra ? [...this.edits, extra] : this.edits;
    const lay = () =>
      g.roadBuilder.plan(
        (n) => {
          for (const e of list) if (e(n) === false) return false;
          return list.length > 0;
        },
        { shove: !!this.opts.shove },
      );
    if (extra) return lay();
    const key = `${this.version}|${idOf(g.roads.net)}.${g.roads.net.version}|${Math.floor(g.budget)}`;
    if (this.cache?.key !== key) this.cache = { key, plan: lay() };
    return this.cache.plan;
  }

  /** Сеть с проектом — от неё тянут следующую правку; правок нет (или сеть так уже не правится) — null. */
  net(): LaneNet | null {
    return this.edits.length ? this.plan().net : null;
  }

  /** Добавить правку. Так не выходит совсем (не правится сеть) — причина, а правка не добавляется; не проходит проверку — добавляется (красным), её можно поправить следующей. */
  add(edit: NetEdit): string | null {
    const plan = this.plan(edit);
    if (!plan.net) return plan.reason ?? 'Так не передвинуть';
    this.edits.push(edit);
    this.version++;
    return null;
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
    if (!this.edits.length) return 'Проект пуст';
    const g = this.game();
    const plan = this.plan();
    if (!plan.ok) return plan.reason ?? 'Так не передвинуть';
    g.checkpoint(this.opts.label ?? 'перенос дороги');
    g.roadBuilder.apply(plan);
    // Дома, на которые налезла расширенная дорога или съезд, отодвигаются — как после обычной полосы.
    if (this.opts.shove) for (const id of plan.changed) g.roadWidened(id);
    g.commit();
    this.clear();
    return null;
  }
}
