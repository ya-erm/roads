import { add, sub, type Vec } from '../core/vec';
import type { Game } from '../game/game';
import type { ToolOverlay } from '../render/renderer';
import type { DecorKind } from '../world/parkParts';

export const DECOR_NAMES: Record<DecorKind, string> = {
  bench: 'Скамейка', lamp: 'Фонарь', bin: 'Урна', tree: 'Дерево', flowerbed: 'Клумба',
  fountain: 'Фонтан', pond: 'Пруд', playground: 'Детская площадка', kiosk: 'Киоск', statue: 'Памятник', obelisk: 'Обелиск',
};

type Hit = NonNullable<ReturnType<Game['parkObjectAt']>>;

export class ParkDecorEditor {
  kind: DecorKind = 'bench';
  angle = 0;
  private drag: { hit: Hit; offset: Vec; angle: number } | null = null;
  private selected: Hit | null = null;

  cancel(): boolean {
    const active = this.drag !== null || this.selected !== null;
    this.drag = null;
    this.selected = null;
    return active;
  }

  beginMove(hit: Hit, pointer: Vec): void {
    this.selected = hit;
    this.drag = { hit, offset: sub(hit.object.pos, pointer), angle: hit.object.angle };
  }

  rotate(delta: number, placing: boolean): boolean {
    if (this.drag) this.drag.angle += delta;
    else if (placing) this.angle += delta;
    else return false;
    return true;
  }

  place(game: Game, p: Vec): string | null {
    return game.placeParkObject(game.parkAt(p)?.park.id ?? null, this.kind, p, this.angle);
  }

  finishMove(game: Game, p: Vec, moved: boolean): { reason: string | null } | null {
    const drag = this.drag;
    if (!drag) return null;
    this.drag = null;
    const { hit, offset, angle } = drag;
    const pos = add(p, offset);
    const changed = moved || angle !== hit.object.angle;
    const reason = changed ? game.moveParkObject(hit.park?.id ?? null, hit.object.id, pos, angle) : null;
    if (changed && !reason) this.selected = game.parkObjectAt(pos);
    return { reason };
  }

  selectedOverlay(game: Game): Partial<ToolOverlay> | null {
    if (!this.selected) return null;
    const hit = game.parkObjectAt(this.selected.object.pos);
    if (!hit || hit.object.id !== this.selected.object.id || hit.park?.id !== this.selected.park?.id) return null;
    return { ...this.highlight(hit, false), label: { text: DECOR_NAMES[hit.object.kind], ok: true } };
  }

  preview(game: Game, p: Vec, placing: boolean): Partial<ToolOverlay> | null {
    const drag = this.drag;
    if (!placing && !drag) return null;
    const pos = drag ? add(p, drag.offset) : p;
    const kind = drag?.hit.object.kind ?? this.kind;
    const angle = drag?.angle ?? this.angle;
    const park = drag ? drag.hit.park : game.parkAt(pos)?.park;
    const plan = game.parkObjectPlan(park?.id ?? null, kind, pos, drag?.hit.object.id, angle);
    return {
      parkDecor: { kind, pos, angle, ok: plan.ok, object: drag?.hit.object },
      label: { text: plan.reason ?? DECOR_NAMES[kind], ok: plan.ok },
    };
  }

  highlight(hit: Hit, remove: boolean): Partial<ToolOverlay> {
    const { object } = hit;
    return {
      parkDecor: { object, kind: object.kind, pos: object.pos, angle: object.angle, ok: true, remove },
      label: { text: `${DECOR_NAMES[object.kind]} · ${remove ? 'убрать' : 'тянуть мышью'}`, ok: true },
    };
  }
}
