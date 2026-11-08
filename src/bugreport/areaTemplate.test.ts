import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { add, dist, type Vec } from '../core/vec';
import { Game } from '../game/game';
import { saveFileText } from '../game/saveFile';
import { parseTemplateFile, TEMPLATE_FILE_KIND, TEMPLATE_FILE_VERSION, templatesToFile } from '../game/templates';
import { AVENUE, road } from '../game/testkit';
import { areaTemplate, schemeBox, schemeName, schemeNote } from './areaTemplate';
import type { MapSpot } from './spot';

const newGame = (seed = 11) => new Game({ seed, size: 'medium', towns: 2, industries: 'few', money: 50_000_000, water: 'dry' });

/** Первое место сетки, где получилось. */
function somewhere(game: Game, tryAt: (p: Vec) => boolean): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 200) {
    for (let x = 400; x < game.terrain.width - 400; x += 200) {
      const p = { x, y };
      const before = game.roads.net.clone();
      if (tryAt(p)) return p;
      game.roads.replace(before);
      game.networkChanged();
    }
  }
  throw new Error('нет места');
}

/** Перекрёсток двух проспектов с плечами по 150 м. */
const crossroads = (game: Game) =>
  somewhere(game, (p) => road(game, { free: add(p, { x: -150, y: 0 }) }, { free: add(p, { x: 150, y: 0 }) }, AVENUE) && road(game, add(p, { x: 0, y: -150 }), add(p, { x: 0, y: 150 }), AVENUE));

const spotAt = (p: Vec, half: number, source: MapSpot['source']): MapSpot => ({
  camera: { x: p.x, y: p.y, zoom: 1 },
  view: { x0: p.x - 600, y0: p.y - 400, x1: p.x + 600, y1: p.y + 400 },
  area: { x0: p.x - half, y0: p.y - half, x1: p.x + half, y1: p.y + half },
  source,
});

const at = new Date(2026, 10, 8, 2, 21, 5);

describe('Схема участка баг-репорта', { timeout: 60_000 }, () => {
  it('участок рамкой или по пометкам — да; по кадру или без участка — нет', () => {
    const p = { x: 1000, y: 500 };
    expect(schemeBox(spotAt(p, 100, 'frame'))).toEqual({ x0: 900, y0: 400, x1: 1100, y1: 600 });
    expect(schemeBox(spotAt(p, 100, 'marks'))).not.toBeNull();
    expect(schemeBox(spotAt(p, 100, 'crop'))).toBeNull();
    expect(schemeBox({ camera: { x: 0, y: 0, zoom: 1 }, view: { x0: 0, y0: 0, x1: 10, y1: 10 } })).toBeNull();
    expect(schemeBox(undefined)).toBeNull();
  });

  it('дороги в рамке — тем же кодом, что копирование рамкой, файлом шаблона развязки', () => {
    const game = newGame();
    const p = crossroads(game);
    const spot = spotAt(p, 100, 'frame');
    const t = areaTemplate((a, b) => game.copyArea(a, b), spot, at)!;
    expect(t).not.toBeNull();
    // Ровно то, что дала бы рамка копирования по тем же углам.
    expect(t.fragment).toEqual(game.copyArea({ x: spot.area!.x0, y: spot.area!.y0 }, { x: spot.area!.x1, y: spot.area!.y1 }));
    expect(t.fragment.corridors).toHaveLength(4);
    expect(t.name).toBe('Участок из отчёта 08.11 02:21');
    expect(schemeNote(t.fragment)).toBe('4 дороги');
    // Формат — как у «Скачать шаблон файлом».
    const file = JSON.parse(t.text);
    expect(file.kind).toBe(TEMPLATE_FILE_KIND);
    expect(file.version).toBe(TEMPLATE_FILE_VERSION);
    expect(t.text).toBe(templatesToFile([{ name: t.name, createdAt: at.getTime(), fragment: t.fragment }]));
  });

  it('файл открывается импортом шаблонов (и сжатый gzip, как с доски) и вставляется в пустую партию', async () => {
    const game = newGame();
    const p = crossroads(game);
    const t = areaTemplate((a, b) => game.copyArea(a, b), spotAt(p, 100, 'marks'), at)!;
    for (const blob of [new Blob([t.text]), new Blob([gzipSync(Buffer.from(t.text))])]) {
      const parsed = parseTemplateFile(await saveFileText(blob));
      if ('error' in parsed) throw new Error(parsed.error);
      expect(parsed.skipped).toBe(0);
      expect(parsed.templates).toHaveLength(1);
      expect(parsed.templates[0]).toEqual({ name: t.name, createdAt: at.getTime(), fragment: t.fragment });
    }
    const parsed = parseTemplateFile(t.text);
    if ('error' in parsed) throw new Error(parsed.error);
    const frag = parsed.templates[0].fragment;
    // Другая партия, где дорог ещё нет: шаблон ставится в чистое поле.
    const empty = newGame(23);
    const before = empty.roads.net.corridors.size;
    const q = somewhere(empty, (x) => empty.pastePlan(frag, x, 0).ok);
    expect(empty.paste(frag, q, 0)).toBeNull();
    const net = empty.roads.net;
    expect(net.problems()).toEqual([]);
    expect(net.corridors.size).toBe(before + 4);
    expect([...net.nodes.values()].some((n) => n.kind === 'junction' && dist(n.pos, q) < 1)).toBe(true);
  });

  it('в рамке нет дорог или участок по кадру — схемы нет', () => {
    const game = newGame();
    const p = crossroads(game);
    const copy = (a: Vec, b: Vec) => game.copyArea(a, b);
    expect(areaTemplate(copy, spotAt(add(p, { x: 70, y: 70 }), 30, 'frame'), at)).toBeNull();
    expect(areaTemplate(copy, spotAt(p, 100, 'crop'), at)).toBeNull();
    expect(areaTemplate(copy, undefined, at)).toBeNull();
  });

  it('что в схеме — словами', () => {
    const frag = { half: { x: 1, y: 1 }, nodes: [], corridors: [{}] } as never;
    expect(schemeNote(frag)).toBe('1 дорога');
    expect(schemeNote({ half: { x: 1, y: 1 }, nodes: [], corridors: new Array(11).fill({}), rail: { nodes: [], segs: [{}, {}] } } as never)).toBe('11 дорог · 2 пути');
    expect(schemeName(new Date(2026, 0, 2, 3, 4))).toBe('Участок из отчёта 02.01 03:04');
  });
});
