import { describe, expect, it } from 'vitest';
import { freshGame, road } from '../game/testkit';
import { parkCardHtml, parkAreaText } from '../ui/parkCard';
import type { Town, TownPark } from './entities';
import { ParkIndex } from './parkPick';
import { NEW_GAME_SETTINGS } from './settings';

/** Точка в осях участка парка: u — вдоль x участка, v — вдоль y. */
const local = (p: TownPark, u: number, v: number) => {
  const c = Math.cos(p.fp.angle);
  const s = Math.sin(p.fp.angle);
  return { x: p.fp.center.x + u * c - v * s, y: p.fp.center.y + u * s + v * c };
};

const town = (id: number, parks: TownPark[]): Town => ({ id, name: `Город ${id}`, parks }) as unknown as Town;

describe('Выбор парка мышью', { timeout: 60_000 }, () => {
  it('сетка: точка внутри повёрнутого участка — его парк, у угла описанного квадрата — нет; по id; дописали парк — найдётся', () => {
    const square: TownPark = { id: 101, kind: 'square', fp: { center: { x: 300, y: 300 }, w: 30, h: 10, angle: Math.PI / 4 } };
    const plaza: TownPark = { id: 201, kind: 'plaza', fp: { center: { x: 2000, y: 900 }, w: 40, h: 24, angle: 0 } };
    const towns = [town(1, [square]), town(2, [plaza])];
    const idx = new ParkIndex();
    expect(idx.at(towns, local(square, 12, 3))?.park).toBe(square);
    expect(idx.at(towns, local(plaza, -19, 11))?.town.id).toBe(2);
    // Внутри рамки по осям мира, но вне повёрнутого прямоугольника.
    expect(idx.at(towns, { x: 300 + 10, y: 300 - 10 })).toBeNull();
    expect(idx.at(towns, { x: 1000, y: 1000 })).toBeNull();
    expect(idx.get(towns, 201)?.park).toBe(plaza);
    // Город вырос — placeParks дописывает в тот же список: сетка пересобирается сама.
    const more: TownPark = { id: 102, kind: 'park', fp: { center: { x: 600, y: 300 }, w: 60, h: 40, angle: 0 } };
    towns[0].parks!.push(more);
    expect(idx.at(towns, { x: 620, y: 310 })?.park).toBe(more);
    expect(idx.get(towns, 102)?.park).toBe(more);
    // Новый мир (загрузка) — новый список городов.
    expect(idx.at([town(3, [])], local(square, 0, 0))).toBeNull();
  });

  it('в мире по seed: парк под курсором — его город; дорога поверх парка — не парк; карточка — вид, город, площадь, что внутри', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1 });
    const t = g.towns.find((x) => x.parks?.some((p) => p.kind === 'park'))!;
    const park = t.parks!.find((p) => p.kind === 'park')!;
    // Вглубь участка, в стороне от середины — на газоне, а не на будущей дороге.
    const lawn = local(park, 0, park.fp.h * 0.3);
    expect(g.structureAt(lawn)).toBeNull();
    expect(g.parkAt(lawn)?.park).toBe(park);
    expect(g.parkAt(lawn)?.town).toBe(t);
    expect(g.parkById(park.id)?.park).toBe(park);

    const html = parkCardHtml(g, park.id);
    expect(html).toContain('Парк');
    expect(html).toContain(t.name);
    expect(html).toContain(parkAreaText(park));
    expect(html).toContain('data-tip="Деревья"');
    expect(html).not.toContain('title=');

    // Дорога игрока насквозь по середине участка: на её полотне — не парк, на газоне в стороне — по-прежнему парк.
    g.money = 1e9;
    const a = local(park, -park.fp.w / 2 + 4, 0);
    const b = local(park, park.fp.w / 2 - 4, 0);
    expect(road(g, { free: a }, { free: b })).toBe(true);
    expect(g.parkAt(local(park, 0, 0))).toBeNull();
    expect(g.parkAt(lawn)?.park).toBe(park);
  });

  it('площадь участка: до гектара — в м², дальше — в га', () => {
    expect(parkAreaText({ fp: { center: { x: 0, y: 0 }, w: 26, h: 20, angle: 0 } })).toBe('520 м²');
    expect(parkAreaText({ fp: { center: { x: 0, y: 0 }, w: 86, h: 62, angle: 0 } })).toBe(`${(5330).toLocaleString('ru-RU')} м²`);
    expect(parkAreaText({ fp: { center: { x: 0, y: 0 }, w: 120, h: 84, angle: 0 } })).toBe(`${(1.01).toLocaleString('ru-RU', { minimumFractionDigits: 2 })} га`);
  });
});
