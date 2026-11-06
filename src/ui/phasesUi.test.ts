import { describe, expect, it } from 'vitest';
import { compassOf, type JunctionInfo, type JunctionPhase, type TurnKind } from '../game/game';
import type { LaneNode } from '../lanes/model';
import { phasesHtml, phaseTurns, turnLabel } from './phasesUi';

/** Крест: подъезды 1 (запад), 2 (восток), 3 (север), 4 (юг); повороты как в игре. */
function info(phases: Partial<JunctionPhase>[], custom = false): JunctionInfo {
  const dirs: Record<number, { x: number; y: number }> = { 1: { x: -1, y: 0 }, 2: { x: 1, y: 0 }, 3: { x: 0, y: -1 }, 4: { x: 0, y: 1 } };
  const exits: Record<number, [number, TurnKind][]> = {
    1: [[2, 'straight'], [3, 'left'], [4, 'right']],
    2: [[1, 'straight'], [4, 'left'], [3, 'right']],
    3: [[4, 'straight'], [2, 'left'], [1, 'right']],
    4: [[3, 'straight'], [1, 'left'], [2, 'right']],
  };
  const approaches = [1, 2, 3, 4].map((seg) => ({ seg, compass: compassOf(dirs[seg]), dir: dirs[seg] }));
  const label = (seg: number) => compassOf(dirs[seg]);
  return {
    node: {} as LaneNode,
    approaches,
    turns: [1, 2, 3, 4].map((from) => ({ from, label: label(from), exits: exits[from].map(([out, kind]) => ({ out, kind, banned: from === 4 && kind === 'left' })) })),
    pairs: [],
    mainNow: [],
    phases: phases.map((p) => ({ go: [], green: 8, active: false, clearing: false, extra: false, yields: [], clashes: [], ...p })),
    phasesCustom: custom,
    liveTurns: ['1>2', '1>3', '1>4', '2>1', '2>4', '2>3', '3>4', '3>2', '3>1', '4>3', '4>2'],
    label,
    customLanes: 0,
  };
}

describe('Фазы светофора в карточке', () => {
  it('повороты на схеме — только те, по которым можно проехать; подпись значками', () => {
    const i = info([]);
    const turns = phaseTurns(i);
    expect(turns).toHaveLength(11);
    expect(turns.find((t) => t.key === '4>1')).toBeUndefined();
    expect(turns.find((t) => t.key === '1>3')!.name).toBe('З налево на С');
    expect(turnLabel(i, '1>3')).toBe('←↰');
  });

  it('плитка на фазу: стрелки кликаются, налево с уступанием — пунктиром, конфликт — красным; длительность и порядок', () => {
    const html = phasesHtml(
      info([
        { go: ['1>2', '1>3', '2>1'], yields: ['1>3'], active: true },
        { go: ['3>4', '1>2'], clashes: ['3>4', '1>2'], green: 40 },
        { go: ['4>3'], extra: true, green: 4 },
      ], true),
      7,
      null,
    );
    expect(html.match(/class="ph-tile /g)).toHaveLength(3);
    expect(html).toContain('ph-tile active');
    expect(html).toContain('data-action="jn-ph-turn" data-id="7" data-i="0" data-turn="1>3"');
    expect(html).toContain('З налево на С: зелёный, уступает встречным');
    expect(html).toContain('stroke-dasharray');
    expect(html).toContain('С прямо на Ю: конфликт');
    expect(html).toContain('ph-bad');
    expect(html).toContain('ph-auto');
    // Первую не переставить раньше, последнюю — позже; зелёный 40 с — не дольше, 4 с — не короче.
    expect(html).toMatch(/data-action="jn-ph-move" data-id="7" data-i="0" data-d="-1" disabled/);
    expect(html).toMatch(/data-action="jn-ph-move" data-id="7" data-i="2" data-d="1" disabled/);
    expect(html).toMatch(/data-i="1" data-d="2" disabled/);
    expect(html).toMatch(/data-i="2" data-d="-2" disabled/);
    // Свои фазы — «Авто» доступно; налево уступают в фазе 1 — «Стрелки налево» доступны.
    expect(html).toMatch(/data-action="jn-ph-auto" data-id="7"\s+title/);
    expect(html).toMatch(/data-action="jn-ph-arrows" data-id="7"\s+title/);
  });

  it('стрелки налево уже стоят — кнопка неактивна; отказ дать зелёный мигает', () => {
    const phases = [{ go: ['1>3', '2>4'] }, { go: ['1>2', '1>3', '2>1', '2>4'], yields: ['1>3', '2>4'] }];
    const html = phasesHtml(info(phases, true), 7, { node: 7, i: 0, turns: ['3>4', '1>3'] });
    expect(html).toMatch(/data-action="jn-ph-arrows" data-id="7" disabled/);
    expect(html.match(/ph-turn ph-flash/g)).toHaveLength(2);
    // «Авто» без своих фаз — неактивна; одна фаза — не убрать.
    const one = phasesHtml(info([{ go: ['1>2'] }]), 7, null);
    expect(one).toMatch(/data-action="jn-ph-auto" data-id="7" disabled/);
    expect(one).toMatch(/data-action="jn-ph-del" data-id="7" data-i="0" disabled/);
  });
});
