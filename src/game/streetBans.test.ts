import { describe, expect, it } from 'vitest';
import { dist, type Vec } from '../core/vec';
import type { Corridor } from '../lanes/model';
import type { Town } from '../world/entities';
import { Game } from './game';
import { freshGame, road } from './testkit';

const grow = (game: Game, town: Town) => (game as unknown as { growTown(t: Town): void }).growTown(town);
/** Ось полотна точками через 4 м. */
const axis = (c: Corridor): Vec[] => {
  const pts: Vec[] = [];
  for (let s = 0; s <= c.length; s += 4) pts.push(c.lut.pointAt(s));
  return pts;
};
/** Полотно c идёт вдоль оси pts: больше половины его длины — ближе 6 м к ней. */
const along = (c: Corridor, pts: Vec[]) => {
  const own = axis(c);
  const near = own.filter((p) => pts.some((q) => dist(p, q) < 6)).length;
  return near * 2 > own.length;
};
const demolish = (game: Game, id: number) => {
  game.checkpoint('снос');
  const plan = game.roadBuilder.bulldoze([id]);
  game.roadBuilder.apply({ ...plan, ok: true });
  game.commit();
};

const SEED = 7;
/** Город растёт так быстро, как может (жителям всего хватает), months месяцев; true — улица вдоль pts вернулась. */
const growBack = (game: Game, town: Town, pts: Vec[], months: number) => {
  for (let m = 0; m < months; m++) {
    town.growthAcc = Math.max(town.growthAcc, 400);
    grow(game, town);
    if ([...game.roads.net.corridors.values()].some((c) => along(c, pts))) return true;
  }
  return false;
};

let found: { townId: number; id: number } | null = null;
/**
 * Улица в городе, которую город сам прокладывает заново, если её снести и забыть запрет (как было до запретов): за
 * три месяца роста. Ищем по улицам городов, крупные — первыми; нашли — запоминаем на все тесты файла.
 */
function rebuiltStreet(): { game: Game; town: Town; street: Corridor; pts: Vec[] } {
  const take = (f: { townId: number; id: number }) => {
    const game = freshGame(SEED);
    const street = game.roads.net.corridor(f.id);
    return { game, town: game.towns.find((t) => t.id === f.townId)!, street, pts: axis(street) };
  };
  if (found) return take(found);
  const base = freshGame(SEED);
  for (const t of [...base.towns].sort((a, b) => b.population - a.population)) {
    const ids = [...base.roads.net.corridors.values()]
      .filter((c) => c.length > 50 && c.length < 200 && dist(c.lut.pointAt(c.length / 2), t.center) < t.radius && base.streetBanAt(c.id))
      .map((c) => c.id);
    for (const id of ids) {
      const { game, town, pts } = take({ townId: t.id, id });
      demolish(game, id);
      delete town.streetBans;
      if (!growBack(game, town, pts, 3)) continue;
      found = { townId: t.id, id };
      return take(found);
    }
  }
  throw new Error('нет улицы, которую город прокладывает заново');
}

describe('Улица, снесённая игроком: город здесь больше не строит', { timeout: 90_000 }, () => {
  it('снесённую городскую улицу город за два года роста не прокладывает снова; запрет — в сохранении', () => {
    // Без запрета эта улица возвращается за три месяца (rebuiltStreet), с запретом — нет и за два года.
    const { game, town, street, pts } = rebuiltStreet();
    expect(game.streetBanAt(street.id)).toBe(true);
    demolish(game, street.id);
    expect(town.streetBans?.length).toBe(1);
    const corridors = game.roads.net.corridors.size;
    expect(growBack(game, town, pts, 24)).toBe(false);
    // Город при этом растёт дальше — запрет только на этом месте.
    expect(game.roads.net.corridors.size).toBeGreaterThan(corridors);
    // Сохранение и загрузка: запрет на месте; старое сохранение без запретов открывается без них.
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(save.settings, save);
    expect(loaded.towns.find((t) => t.id === town.id)!.streetBans).toEqual(town.streetBans);
    for (const t of save.towns) delete t.streetBans;
    const old = new Game(save.settings, save);
    expect(old.towns.every((t) => !t.streetBans?.length)).toBe(true);
  });

  it('Ctrl+Z после сноса возвращает улицу и снимает запрет, Ctrl+Y — снова запрет', () => {
    const { game, town, street } = rebuiltStreet();
    demolish(game, street.id);
    expect(town.streetBans?.length).toBe(1);
    game.undo();
    expect(game.roads.net.corridors.has(street.id)).toBe(true);
    expect(town.streetBans ?? []).toEqual([]);
    game.redo();
    expect(game.roads.net.corridors.has(street.id)).toBe(false);
    expect(town.streetBans?.length).toBe(1);
  });

  it('дорога игрока на месте снесённой улицы снимает запрет', () => {
    const { game, town, street } = rebuiltStreet();
    const a = street.curve.p0;
    const b = street.curve.p3;
    demolish(game, street.id);
    expect(town.streetBans?.length).toBe(1);
    game.checkpoint('дорога');
    expect(road(game, a, b)).toBe(true);
    game.commit();
    expect(town.streetBans ?? []).toEqual([]);
  });

  it('снос дороги вдали от городов запрета не ставит', () => {
    const game = freshGame(7);
    // Дорога в поле подальше от городов: дальше их застройки на 600 м.
    const { width, height } = game.terrain;
    const far = (p: Vec) => game.towns.every((t) => dist(p, t.center) > (t.extent ?? t.radius) + 600);
    let from: Vec | null = null;
    for (let y = 300; y < height - 300 && !from; y += 97) {
      for (let x = 300; x < width - 600 && !from; x += 97) {
        if (!far({ x, y }) || !far({ x: x + 200, y }) || game.roads.net.corridorsNear({ x: x + 100, y }, 200).length) continue;
        game.checkpoint('дорога');
        if (road(game, { free: { x, y } }, { free: { x: x + 200, y } })) from = { x, y };
        game.commit();
      }
    }
    expect(from).not.toBeNull();
    const a = from!;
    const c = game.roads.net.corridorsNear({ x: a.x + 100, y: a.y }, 5)[0];
    expect(game.streetBanAt(c.id)).toBe(false);
    demolish(game, c.id);
    expect(game.towns.every((t) => !t.streetBans?.length)).toBe(true);
  });
});
