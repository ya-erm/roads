import { describe, expect, it } from 'vitest';
import type { Industry, Station } from '../world/entities';
import { Vec } from '../core/vec';
import { Game, SaveData } from './game';
import { freshGame } from './testkit';
import type { Line } from './transport';

function stationAtIndustry(game: Game, ind: Industry, toward: Vec): Station | null {
  const base = Math.atan2(toward.y - ind.fp.center.y, toward.x - ind.fp.center.x);
  for (const k of [0, 1, -1, 2]) {
    const a = base + (k * Math.PI) / 2;
    const reach = Math.hypot(ind.fp.w, ind.fp.h) / 2 + 20;
    const st = game.placeStation({ x: ind.fp.center.x + Math.cos(a) * reach, y: ind.fp.center.y + Math.sin(a) * reach }, 14);
    if (st) return st;
  }
  return null;
}

/** Игра с двумя линиями между фермой и пищевым комбинатом. */
function setup(): { game: Game; l1: Line; l2: Line } {
  const game = freshGame(7);
  const farm = game.industries.find((i) => i.info.kind === 'farm')!;
  const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
  const a = stationAtIndustry(game, farm, plant.fp.center)!;
  const b = stationAtIndustry(game, plant, farm.fp.center)!;
  const l1 = game.createLine([a.id, b.id])!;
  const l2 = game.createLine([b.id, a.id])!;
  return { game, l1, l2 };
}

const reload = (game: Game) => new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())) as SaveData);

describe('Папки линий', () => {
  it('папка создаётся, переименовывается и получает свободное название по умолчанию', () => {
    const { game } = setup();
    const f1 = game.createFolder();
    const f2 = game.createFolder('  Грузы  ');
    expect(f1.name).toBe('Папка 1');
    expect(f2.name).toBe('Грузы');
    expect(f2.id).not.toBe(f1.id);
    game.renameFolder(f1.id, 'Пассажиры');
    expect(game.folders.get(f1.id)!.name).toBe('Пассажиры');
    // Пустое название не принимается.
    game.renameFolder(f1.id, '   ');
    expect(game.folders.get(f1.id)!.name).toBe('Пассажиры');
    // «Папка 1» освободилась — новая папка получает её.
    expect(game.createFolder().name).toBe('Папка 1');
  });

  it('линия переносится в папку и обратно в корень', () => {
    const { game, l1, l2 } = setup();
    const f = game.createFolder('Грузы');
    game.setLineFolder(l1.id, f.id);
    expect(l1.folder).toBe(f.id);
    expect(game.folderLines(f.id)).toEqual([l1]);
    expect(game.folderLines(null)).toEqual([l2]);
    // В несуществующую папку не переносится — линия остаётся в корне.
    game.setLineFolder(l2.id, 999);
    expect(l2.folder).toBeUndefined();
    game.setLineFolder(l1.id, null);
    expect(l1.folder).toBeUndefined();
    expect(game.folderLines(f.id)).toEqual([]);
  });

  it('удаление папки не удаляет её линии — они возвращаются в корень', () => {
    const { game, l1, l2 } = setup();
    const f = game.createFolder();
    game.setLineFolder(l1.id, f.id);
    game.setLineFolder(l2.id, f.id);
    game.deleteFolder(f.id);
    expect(game.folders.has(f.id)).toBe(false);
    expect(game.lines.size).toBe(2);
    expect(l1.folder).toBeUndefined();
    expect(l2.folder).toBeUndefined();
    expect(game.folderLines(null)).toHaveLength(2);
  });

  it('папки, их линии и свёрнутость сохраняются и загружаются', () => {
    const { game, l1, l2 } = setup();
    const cargo = game.createFolder('Грузы');
    const pax = game.createFolder('Пассажиры');
    game.setLineFolder(l1.id, cargo.id);
    game.toggleFolder(cargo.id);
    expect(cargo.collapsed).toBe(true);
    const loaded = reload(game);
    expect([...loaded.folders.values()].map((f) => f.name)).toEqual(['Грузы', 'Пассажиры']);
    expect(loaded.folders.get(cargo.id)!.collapsed).toBe(true);
    expect(loaded.folders.get(pax.id)!.collapsed).toBeFalsy();
    expect(loaded.lines.get(l1.id)!.folder).toBe(cargo.id);
    expect(loaded.lines.get(l2.id)!.folder).toBeUndefined();
    // Новая папка после загрузки не занимает номер существующей.
    expect(loaded.createFolder().id).toBeGreaterThan(pax.id);
  });

  it('линии переставляются в списке и в папке, порядок сохраняется', () => {
    const { game, l1, l2 } = setup();
    const l3 = game.createLine([...l1.stops])!;
    const ids = () => [...game.lines.keys()];
    expect(ids()).toEqual([l1.id, l2.id, l3.id]);
    // Перед другой линией того же уровня.
    game.moveLine(l3.id, null, l1.id);
    expect(ids()).toEqual([l3.id, l1.id, l2.id]);
    // Без «перед кем» — в конец корня.
    game.moveLine(l3.id, null);
    expect(ids()).toEqual([l1.id, l2.id, l3.id]);
    // В папку: первая линия встаёт в конец папки, вторая — перед ней.
    const f = game.createFolder();
    game.moveLine(l1.id, f.id);
    game.moveLine(l3.id, f.id, l1.id);
    expect(game.folderLines(f.id)).toEqual([l3, l1]);
    expect(game.folderLines(null)).toEqual([l2]);
    // «Перед» линией из другой папки — значит в конец целевой.
    game.moveLine(l2.id, f.id, 999);
    expect(game.folderLines(f.id)).toEqual([l3, l1, l2]);
    game.moveLine(l2.id, f.id, l3.id);
    const loaded = reload(game);
    expect(loaded.folderLines(f.id).map((l) => l.id)).toEqual([l2.id, l3.id, l1.id]);
    expect(loaded.folderLines(null)).toEqual([]);
  });

  it('значок линии: грузовик, автобус или поезд — по транспорту и станциям', () => {
    const { game, l1 } = setup();
    game.money = 5_000_000;
    // Ферма → пищекомбинат без машин: зерно с одной станции принимает другая — грузовая.
    expect(game.lineVehicleKind(l1)).toBe('truck');
    game.buyVehicle(l1.id, 'bus');
    expect(game.lineVehicleKind(l1)).toBe('bus');
    expect(game.lineVehicleKind({ ...l1, mode: 'rail' })).toBe('train');
  });

  it('старое сохранение без папок загружается, ссылка на пропавшую папку сбрасывается', () => {
    const { game, l1 } = setup();
    const f = game.createFolder();
    game.setLineFolder(l1.id, f.id);
    const save = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    delete save.folders;
    const loaded = new Game(game.settings, save);
    expect(loaded.folders.size).toBe(0);
    expect(loaded.lines.get(l1.id)!.folder).toBeUndefined();
    expect(loaded.folderLines(null)).toHaveLength(2);
  });
});
