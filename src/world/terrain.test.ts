import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { roadPlan } from '../game/testkit';
import { RoadTools } from '../input/roadtools';
import { Rng } from '../core/rng';
import { altitudeText, buildContours, heightLabel } from '../render/relief';
import { profileText } from '../game/grade';
import { DEFAULT_SETTINGS } from './settings';
import { Terrain } from './terrain';

const settings = (relief: 'plains' | 'hills' | 'mountains' | undefined, seed = 7) => ({
  ...DEFAULT_SETTINGS,
  seed,
  size: 'small' as const,
  relief,
});

describe('Рельеф', () => {
  it('высота детерминирована по seed: тот же seed — та же карта, другой seed — другая', () => {
    const a = new Terrain(new Rng(7), settings('hills', 7));
    const b = new Terrain(new Rng(7), settings('hills', 7));
    const c = new Terrain(new Rng(9), settings('hills', 9));
    const points = [
      { x: 500, y: 500 },
      { x: 3000, y: 1800 },
      { x: 5900, y: 3900 },
    ];
    for (const p of points) expect(a.heightAt(p)).toBe(b.heightAt(p));
    expect(points.some((p) => a.heightAt(p) !== c.heightAt(p))).toBe(true);
  });

  it('изолинии — векторные линии на уровнях высоты, каждая 5-я — главная; без рельефа их нет', () => {
    const t = new Terrain(new Rng(7), settings('hills', 7));
    const t0 = performance.now();
    const chunks = buildContours(t);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(chunks.some((c) => c.major)).toBe(true);
    expect(chunks.some((c) => !c.major)).toBe(true);
    // Точки лежат на уровне изолинии — кратном шагу по высоте над водой, как в подсказке у курсора
    // (сглаживание сдвигает их совсем немного); главная — каждые 5 шагов.
    let off = 0;
    let n = 0;
    for (const c of chunks.slice(0, 400)) {
      for (let q = 0; q < c.pts.length; q += 2) {
        const h = t.altitudeAt({ x: c.pts[q], y: c.pts[q + 1] });
        const level = Math.round(h / t.contourStep);
        off += Math.abs(h - level * t.contourStep);
        expect(level).not.toBe(0);
        expect(Math.abs(level % 5) === 0).toBe(c.major);
        n++;
      }
    }
    expect(off / n).toBeLessThan(t.contourStep * 0.1);
    expect(buildContours(new Terrain(new Rng(7), settings(undefined, 7)))).toEqual([]);
  });

  it('без выбранного рельефа высота всюду 0 (старые миры и старые сохранения)', () => {
    const t = new Terrain(new Rng(7), settings(undefined, 7));
    for (const p of [{ x: 100, y: 100 }, { x: 4000, y: 2000 }, { x: 6000, y: 4000 }]) {
      expect(t.heightAt(p)).toBe(0);
      expect(t.slopeAt(p)).toBe(0);
      expect(t.altitudeAt(p)).toBe(0);
    }
    expect(heightLabel(t, { x: 4000, y: 2000 })).toBeNull();
  });

  it('у курсора — высота над уровнем воды в метрах: в воде 0, на суше — разница с водой', () => {
    const t = new Terrain(new Rng(7), settings('hills', 7));
    const river = t.rivers[0].points[Math.floor(t.rivers[0].points.length / 2)];
    expect(t.isWater(river)).toBe(true);
    expect(t.altitudeAt(river)).toBe(0);
    let top = { x: 0, y: 0 };
    for (let x = 100; x < t.width; x += 200) for (let y = 100; y < t.height; y += 200) if (t.heightAt({ x, y }) > t.heightAt(top)) top = { x, y };
    const alt = t.altitudeAt(top);
    expect(alt).toBeGreaterThan(t.heightAt(top));
    expect(alt - t.heightAt(top)).toBeCloseTo(t.amplitude * 0.22, 5);
    expect(heightLabel(t, top)).toBe(`высота ${Math.round(alt)} м`);
  });

  it('сухая низина ниже уровня воды — отрицательная высота, а не 0', () => {
    const t = new Terrain(new Rng(7), settings('mountains', 7));
    let low = { x: 0, y: 0 };
    for (let x = 100; x < t.width; x += 100) {
      for (let y = 100; y < t.height; y += 100) if (!t.isWater({ x, y }) && t.altitudeAt({ x, y }) < t.altitudeAt(low)) low = { x, y };
    }
    const alt = t.altitudeAt(low);
    expect(alt).toBeLessThan(-t.contourStep);
    expect(alt).toBeCloseTo(t.heightAt(low) - t.waterLevel, 5);
    expect(heightLabel(t, low)).toBe(`высота −${-Math.round(alt)} м`);
    expect(altitudeText(-0.3)).toBe('высота 0 м');
  });

  it('старое сохранение (без поля relief в settings) грузится и остаётся плоским', () => {
    const game = new Game(settings('mountains', 11));
    expect(game.terrain.hasRelief).toBe(true);
    const save = game.toSave();
    delete (save.settings as { relief?: unknown }).relief;
    const loaded = new Game(save.settings, save);
    expect(loaded.terrain.hasRelief).toBe(false);
    expect(loaded.terrain.heightAt({ x: 3000, y: 2000 })).toBe(0);
  });

  it('уклон считается вдоль дороги: по изолинии на крутом склоне строится, поперёк — нет, с подсказкой', () => {
    const game = new Game(settings('mountains', 13));
    const t = game.terrain;
    const free = (p: { x: number; y: number }) => !t.isWater(p, 30) && t.inBounds(p, 60) && !game.blocked(p, 30);
    let found = false;
    for (let y = 300; y < t.height - 300 && !found; y += 70) {
      for (let x = 300; x < t.width - 300 && !found; x += 70) {
        const p = { x, y };
        if (t.slopeAt(p) < 0.16) continue;
        // Направление подъёма и направление изолинии (поперёк подъёма).
        const gx = t.heightAt({ x: x + 8, y }) - t.heightAt({ x: x - 8, y });
        const gy = t.heightAt({ x, y: y + 8 }) - t.heightAt({ x, y: y - 8 });
        const g = Math.hypot(gx, gy);
        const up = { x: gx / g, y: gy / g };
        const along = { x: -up.y, y: up.x };
        const ends = (d: { x: number; y: number }) => [
          { x: x - d.x * 70, y: y - d.y * 70 },
          { x: x + d.x * 70, y: y + d.y * 70 },
        ];
        const [a1, b1] = ends(along);
        const [a2, b2] = ends(up);
        if (![a1, b1, a2, b2].every(free)) continue;
        // Склон поперёк должен быть крутым на всём отрезке, вдоль изолинии — почти без подъёма.
        if (Math.abs(t.heightAt(b2) - t.heightAt(a2)) < 0.14 * 140 || Math.abs(t.heightAt(b1) - t.heightAt(a1)) > 0.05 * 140) continue;
        const across = roadPlan(game, { free: a2 }, { free: b2 });
        const contour = roadPlan(game, { free: a1 }, { free: b1 });
        if (!contour.ok) continue;
        found = true;
        expect(across.ok).toBe(false);
        expect(across.reason).toMatch(/наискось|тоннель|мост/);
        expect(contour.profile!.grade).toBeLessThanOrEqual(0.1 + 1e-3);
      }
    }
    expect(found).toBe(true);
  });

  it('дорога сглаживает неровности насыпью и выемкой — и стоит дороже, чем по ровному', () => {
    const game = new Game(settings('hills', 7));
    const t = game.terrain;
    let found = false;
    for (let y = 300; y < t.height - 300 && !found; y += 60) {
      for (let x = 300; x < t.width - 600 && !found; x += 60) {
        const a = { x, y };
        const b = { x: x + 240, y };
        if (t.isWater(a, 30) || t.isWater(b, 30) || game.blocked(a, 30) || game.blocked(b, 30)) continue;
        const plan = roadPlan(game, { free: a }, { free: b });
        if (!plan.ok || !plan.profile || Math.max(plan.profile.cut, plan.profile.fill) < 1.5) continue;
        found = true;
        expect(plan.profile.grade).toBeLessThanOrEqual(0.1 + 1e-3);
        const flat = roadPlan(new Game(settings(undefined, 7)), { free: a }, { free: b });
        if (flat.ok) expect(plan.cost).toBeGreaterThan(flat.cost);
      }
    }
    expect(found).toBe(true);
  });

  it('кисть рельефа: поднимает, опускает (не ниже воды), выравнивает; отмена возвращает исходный рельеф', () => {
    const t = new Terrain(new Rng(7), settings('hills', 7));
    const p = { x: 3000, y: 2000 };
    const h0 = t.heightAt(p);
    t.terraform({ ...p, r: 80, mode: 'raise', amount: 2 });
    expect(t.heightAt(p)).toBeCloseTo(h0 + 2, 0);
    // Край кисти почти не тронут.
    expect(Math.abs(t.heightAt({ x: p.x + 79, y: p.y }) - new Terrain(new Rng(7), settings('hills', 7)).heightAt({ x: p.x + 79, y: p.y }))).toBeLessThan(0.1);
    for (let i = 0; i < 200; i++) t.terraform({ ...p, r: 80, mode: 'lower', amount: 2 });
    const floor = t.heightAt(p);
    t.terraform({ ...p, r: 80, mode: 'lower', amount: 2 });
    expect(t.heightAt(p)).toBeCloseTo(floor, 5);
    expect(floor).toBeGreaterThan(-t.amplitude * 0.22);
    t.truncateEdits(0);
    expect(t.heightAt(p)).toBe(h0);
    const q = { x: 3100, y: 2050 };
    const hq = t.heightAt(q);
    for (let i = 0; i < 20; i++) t.terraform({ ...q, r: 80, mode: 'flatten', amount: 1, target: hq + 5 });
    expect(t.heightAt(q)).toBeCloseTo(hq + 5, 0);
  });

  it('рельеф меняется за деньги, правки переживают сохранение, Ctrl+Z их отменяет; под предприятием нельзя', () => {
    const game = new Game({ ...settings('hills', 7), money: 5_000_000 });
    const t = game.terrain;
    let p = { x: 0, y: 0 };
    for (let y = 400; y < t.height - 400 && !p.x; y += 50) {
      for (let x = 400; x < t.width - 400; x += 50) {
        if (game.terraformPlan({ x, y }, 'raise', 80).ok) {
          p = { x, y };
          break;
        }
      }
    }
    const h0 = t.heightAt(p);
    const money = game.money;
    game.checkpoint('рельеф');
    expect(game.terraform(p, 'raise', 80)).toBe(true);
    game.commit();
    expect(game.money).toBeLessThan(money);
    expect(t.heightAt(p)).toBeGreaterThan(h0 + 1);
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.terrain.heightAt(p)).toBeCloseTo(t.heightAt(p), 5);
    expect(game.undo()).toBe('рельеф');
    expect(t.heightAt(p)).toBe(h0);
    expect(game.money).toBe(money);
    const ind = game.industries[0];
    expect(game.terraformPlan(ind.fp.center, 'raise', 80).reason).toBe('Мешает предприятие');
  });

  it('склон, по которому дорога не проходит, можно срыть кистью — и дорога строится', () => {
    const game = new Game({ ...settings('mountains', 13), money: 50_000_000 });
    const t = game.terrain;
    const free = (p: { x: number; y: number }) => !t.isWater(p, 60) && t.inBounds(p, 200) && !game.blocked(p, 120) && !game.roads.net.corridorsNear(p, 150).length;
    let done = false;
    for (let y = 400; y < t.height - 400 && !done; y += 80) {
      for (let x = 400; x < t.width - 400 && !done; x += 80) {
        const a = { x, y };
        const b = { x: x + 160, y };
        if (!free(a) || !free(b)) continue;
        const before = roadPlan(game, { free: a }, { free: b });
        if (before.ok || !/Выемка|Насыпь/.test(before.reason ?? '')) continue;
        // Выравниваем полосу под дорогой к высоте её начала.
        const target = t.heightAt(a);
        for (let k = 0; k < 40; k++) for (let s = 0; s <= 160; s += 40) game.terraform({ x: x + s, y }, 'flatten', 80, target);
        const after = roadPlan(game, { free: a }, { free: b });
        done = true;
        expect(after.ok).toBe(true);
      }
    }
    expect(done).toBe(true);
  });

  it('«Авто»: дорога, упёршаяся в насыпь, сама строится с мостом и пандусами; конец −/+ — выше начала', () => {
    const game = new Game({ ...settings('mountains', 13), money: 50_000_000 });
    const t = game.terrain;
    const rt = new RoadTools(() => game);
    const spec = { cls: 'street' as const, lanesF: 1, lanesB: 1 };
    const free = (p: { x: number; y: number }) => !t.isWater(p, 40) && t.inBounds(p, 100) && !game.blocked(p, 60) && !game.roads.net.corridorsNear(p, 80).length;
    let done = false;
    for (let y = 400; y < t.height - 400 && !done; y += 60) {
      for (let x = 400; x < t.width - 800 && !done; x += 60) {
        const a = { x, y };
        const b = { x: x + 360, y };
        if (!free(a) || !free(b) || !free({ x: x + 180, y })) continue;
        rt.clear();
        rt.auto = false;
        rt.begin(a, 10);
        const ground = rt.buildPlan(b, spec, 'straight', 10, false);
        if (!ground || ground.ok || !/^Насыпь/.test(ground.reason ?? '')) continue;
        rt.auto = true;
        const auto = rt.buildPlan(b, spec, 'straight', 10, false);
        // Ищем мост с пандусами между участками на земле; мост на всю длину (круча прямо у начала) — другой случай.
        if (!auto?.ok || rt.autoInfo!.bridge >= 360 - 1) continue;
        done = true;
        expect(rt.autoInfo!.bridge).toBeGreaterThan(0);
        expect(rt.build(b, spec, 'straight', 10, false)).toBeNull();
        const net = game.roads.net;
        const fresh = [...net.corridors.values()].filter((c) => c.lut.closest({ x: c.lut.pointAt(c.length / 2).x, y }).d < 2 && Math.abs(c.lut.pointAt(c.length / 2).y - y) < 2);
        const levels = new Set(fresh.flatMap((c) => [net.node(c.a).level, net.node(c.b).level]));
        expect(levels.has(1)).toBe(true);
        // Ровный конец остался на земле: мост между пандусами.
        expect(levels.has(0)).toBe(true);
      }
    }
    expect(done).toBe(true);
    // Высота конца: на 10 м выше начала на ровном месте — конец уже на мосту.
    const plain = new Game({ ...settings('plains', 13), money: 50_000_000 });
    const rp = new RoadTools(() => plain);
    const pt = plain.terrain;
    let raised = false;
    for (let y = 400; y < pt.height - 400 && !raised; y += 80) {
      for (let x = 400; x < pt.width - 800 && !raised; x += 80) {
        const a = { x, y };
        const b = { x: x + 300, y };
        if ([a, b, { x: x + 150, y }].some((p) => pt.isWater(p, 40) || plain.blocked(p, 60) || plain.roads.net.corridorsNear(p, 80).length)) continue;
        rp.clear();
        rp.begin(a, 10);
        rp.rise = 10;
        const plan = rp.buildPlan(b, spec, 'straight', 10, false);
        if (!plan?.ok) continue;
        raised = true;
        expect(rp.autoInfo!.endLevel).toBe(1);
      }
    }
    expect(raised).toBe(true);
  });

  it('дорога по неровному ровному месту идёт ровно: уклон между концами, без «местами» на каждом бугре; конец — где выйдет', () => {
    const game = new Game({ ...settings('hills', 7), money: 50_000_000 });
    const t = game.terrain;
    const rt = new RoadTools(() => game);
    const spec = { cls: 'street' as const, lanesF: 1, lanesB: 1 };
    const L = 160;
    const n = 20;
    let found = false;
    for (let y = 300; y < t.height - 300 && !found; y += 40) {
      for (let x = 300; x < t.width - 600 && !found; x += 40) {
        const a = { x, y };
        const b = { x: x + L, y };
        if ([a, b, { x: x + L / 2, y }].some((p) => t.isWater(p, 30) || game.blocked(p, 40) || game.roads.net.corridorsNear(p, 60).length)) continue;
        // Концы почти на одной высоте, по пути — бугры (на 8 м круче 6%), но не выше 1.5 м.
        const h = Array.from({ length: n + 1 }, (_, i) => t.heightAt({ x: x + (L * i) / n, y }));
        if (Math.abs(h[n] - h[0]) > 0.5 || h.some((v) => Math.abs(v - h[0]) > 1.5)) continue;
        if (!h.some((v, i) => i > 0 && Math.abs(v - h[i - 1]) / (L / n) > 0.06)) continue;
        rt.clear();
        rt.rise = null;
        rt.begin(a, 10);
        const plan = rt.buildPlan(b, spec, 'straight', 10, false);
        if (!plan?.ok || !plan.profile || rt.autoInfo) continue;
        found = true;
        expect(plan.profile.slope).toBeCloseTo((h[n] - h[0]) / L, 2);
        expect(plan.profile.grade).toBeLessThan(0.01);
        expect(profileText(plan.profile)).toMatch(/^→ 0%( · (насыпь|выемка) \d м)*$/);
        // Конец на 2 м выше начала: моста не нужно — конец на земле, там, где земля.
        rt.rise = 2;
        rt.buildPlan(b, spec, 'straight', 10, false);
        expect(rt.autoInfo).toBeNull();
        expect(rt.endLevel).toBe(0);
        expect(rt.endRise).toBeCloseTo(h[n] - h[0], 1);
      }
    }
    expect(found).toBe(true);
  });

  it('на равнине тот же манёвр — обычная дорога без ограничения по уклону', () => {
    const game = new Game(settings('plains', 13));
    const a = { x: 2000, y: 1500 };
    const b = { x: 2160, y: 1500 };
    if (!game.isWater(a, 20) && !game.isWater(b, 20)) {
      const plan = roadPlan(game, { free: a }, { free: b });
      expect(plan.ok || !(plan.reason ?? '').match(/уклон/)).toBe(true);
    }
  });
});
