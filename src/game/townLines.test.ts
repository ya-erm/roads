import { describe, expect, it } from 'vitest';
import { buildBusScene } from '../testpages/bus';
import { linesForTown } from './townLines';

const st = (id: number, ...townIds: number[]) => ({ id, townIds });
const line = (name: string, ...stops: number[]) => ({ name, stops });
const names = (list: { name: string }[]) => list.map((l) => l.name);

describe('Маршруты города', () => {
  // Город 1: станции 1 и 2; город 2: станция 3; станция 2 — на границе, в охвате обоих; 4 — в поле.
  const stations = [st(1, 1), st(2, 1, 2), st(3, 2), st(4)];
  const lines = [line('по городу', 1, 2), line('межгород', 1, 3), line('по соседу', 3, 3), line('через границу', 4, 2), line('в поле', 4, 4)];

  it('маршрут относится к городу, если хотя бы одна его остановка — в охвате домов города', () => {
    expect(names(linesForTown(lines, stations, 1))).toEqual(['по городу', 'межгород', 'через границу']);
    expect(names(linesForTown(lines, stations, 2))).toEqual(['по городу', 'межгород', 'по соседу', 'через границу']);
  });

  it('у города без станций и у несуществующего города маршрутов нет', () => {
    expect(linesForTown(lines, stations, 3)).toEqual([]);
    expect(linesForTown(lines, [], 1)).toEqual([]);
    expect(linesForTown([], stations, 1)).toEqual([]);
  });

  it('порядок — как в общем списке, маршрут не повторяется, даже если заходит в город несколько раз', () => {
    const many = [line('б', 3, 1, 2, 1), line('а', 2)];
    expect(names(linesForTown(many, stations, 1))).toEqual(['б', 'а']);
  });

  it('в игре: у каждого участка сцены /test/bus — только его маршруты', { timeout: 60_000 }, () => {
    const { game, lines: ids, errors } = buildBusScene();
    expect(errors).toEqual([]);
    const town = (name: string) => game.towns.find((t) => t.name === name)!.id;
    const of = (name: string) => game.townLines(town(name)).map((l) => l.id);
    expect(of('Прямая')).toEqual([ids.straight]);
    expect(of('Кварталы')).toEqual([ids.block, ids.block2]);
    // Каждый маршрут сцены — хотя бы у одного участка, и ни один участок не показывает маршруты «Кварталов», кроме них самих.
    const all = new Set(game.towns.flatMap((t) => game.townLines(t.id).map((l) => l.id)));
    expect([...all].sort()).toEqual(Object.values(ids).sort());
    for (const t of game.towns.filter((t) => t.name !== 'Кварталы')) expect(game.townLines(t.id).map((l) => l.id)).not.toContain(ids.block);
  });
});
