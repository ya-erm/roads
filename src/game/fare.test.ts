import { describe, expect, it } from 'vitest';
import { ECONOMY } from '../config';
import type { Vec } from '../core/vec';
import { CARGO } from '../world/cargo';
import { paxDistance, paxFare, ridePath } from './fare';
import { MODELS } from './transport';

/** Кольцо остановок 1…n по окружности радиуса r — как городская линия вокруг центра. */
function ring(n: number, r: number) {
  const stops = Array.from({ length: n }, (_, i) => i + 1);
  const at = new Map<number, Vec>(stops.map((id, i) => [id, { x: r * Math.cos((2 * Math.PI * i) / n), y: r * Math.sin((2 * Math.PI * i) / n) }]));
  return { stops, pos: (id: number) => at.get(id) };
}

/** Тариф только за расстояние (пассажирский — ECONOMY.paxDistance от грузового) — как платили до билета и объезда. */
const byDistance = (d: number, k = 1) => (CARGO.passengers.rate * ECONOMY.tariff * ECONOMY.paxDistance * d * k) / 100;

describe('Плата пассажиров', () => {
  it('путь по линии — перегоны от посадки до высадки по ходу линии, через конец круга тоже', () => {
    const line = { stops: [10, 20, 30], pos: (id: number) => ({ 10: { x: 0, y: 0 }, 20: { x: 300, y: 0 }, 30: { x: 300, y: 400 } })[id] };
    // Сели на первой, вышли на третьей: 300 + 400.
    expect(ridePath(line.stops, line.pos, 10, 2)).toBeCloseTo(700);
    // Сели на третьей, вышли на второй: 30 → 10 → 20 — через конец списка.
    expect(ridePath(line.stops, line.pos, 30, 1)).toBeCloseTo(500 + 300);
    // Станции посадки на линии больше нет — пути нет, платят по прямой.
    expect(ridePath(line.stops, line.pos, 99, 1)).toBeNull();
  });

  it('на линии из двух остановок и на прямой линии платят как раньше — по прямой', () => {
    expect(paxDistance(1200, 1200)).toBe(1200);
    expect(paxDistance(1200, null)).toBe(1200);
    const line = { stops: [1, 2, 3], pos: (id: number) => ({ x: id * 300, y: 0 }) };
    // 1 → 3 по прямой улице: объезда нет.
    expect(paxDistance(600, ridePath(line.stops, line.pos, 1, 2))).toBeCloseTo(600);
  });

  it('объезд по кольцу оплачивается долей ECONOMY.paxDetour', () => {
    const { stops, pos } = ring(6, 200);
    // До соседней по прямой остановки (6 → 1 по кругу — 1 → 6 едут пять перегонов по 200).
    const path = ridePath(stops, pos, 1, 5)!;
    expect(path).toBeCloseTo(1000);
    expect(paxDistance(200, path)).toBeCloseTo(200 + ECONOMY.paxDetour * 800);
    expect(ECONOMY.paxDetour).toBeGreaterThan(0);
    expect(ECONOMY.paxDetour).toBeLessThan(1);
  });

  it('билет за посадку прибавляется к тарифу за расстояние, за каждого пассажира', () => {
    expect(paxFare(3, 1000, null, 1.2)).toBeCloseTo(3 * (ECONOMY.paxBoarding + byDistance(1000, 1.2)));
  });

  it('городская линия по кругу окупает автобус, а междугородней билет прибавляет немного', () => {
    // Кольцо из 7 остановок по 240 м, как в городе среднего размера: пассажиры едут в среднем 3,5 перегона,
    // по прямой — около 300 м. Полный автобус делает за месяц около двух перегонов (город медленный).
    const { stops, pos } = ring(7, 240 / (2 * Math.sin(Math.PI / 7)));
    let paid = 0;
    let before = 0;
    let rides = 0;
    for (let from = 0; from < 7; from++) {
      for (let to = 0; to < 7; to++) {
        if (from === to) continue;
        const a = pos(stops[from])!;
        const b = pos(stops[to])!;
        const straight = Math.hypot(a.x - b.x, a.y - b.y);
        // Медленно по городу — надбавка за скорость на нижнем пределе.
        paid += paxFare(1, straight, ridePath(stops, pos, stops[from], to), ECONOMY.speedMin);
        before += byDistance(straight, ECONOMY.speedMin);
        rides++;
      }
    }
    // В среднем пассажир проезжает 3,5 перегона: за два перегона в месяц автобус на 30 мест довозит ~17 человек.
    const perMonth = (30 * 2) / 3.5;
    const running = MODELS.bus.running;
    expect((before / rides) * perMonth).toBeLessThan(running);
    expect((paid / rides) * perMonth).toBeGreaterThan(running);
    expect((paid / rides) * perMonth).toBeLessThan(running * 1.5);
    // Междугородний пассажир — между центрами соседних городов крупной карты (~3,1 км, WorldSettings.mapScale): билет
    // и объезд (его нет) — меньше десятой части платы.
    expect(paxFare(1, 3100, 3100, 1) / byDistance(3100)).toBeLessThan(1.1);
  });

  it('пассажиру метр дешевле, чем грузу той же ставки, а поездка по городу на ~650 м — как до крупных карт', () => {
    expect(ECONOMY.paxDistance).toBeGreaterThan(0.5);
    expect(ECONOMY.paxDistance).toBeLessThan(1);
    // До крупных карт: билет $20 и полный тариф за метр.
    const old = (d: number, k: number) => 20 + (CARGO.passengers.rate * ECONOMY.tariff * d * k) / 100;
    const k = 0.9;
    expect(paxFare(1, 650, null, k) / old(650, k)).toBeGreaterThan(0.95);
    expect(paxFare(1, 650, null, k) / old(650, k)).toBeLessThan(1.05);
    // Короче — дороже, но не вдвое; длиннее (через весь город) — дешевле, но не меньше 80%.
    expect(paxFare(1, 250, null, k) / old(250, k)).toBeLessThan(1.4);
    expect(paxFare(1, 1200, null, k) / old(1200, k)).toBeGreaterThan(0.8);
    // Междугородняя: на прежней карте ~2,1 км, на крупной ~3,1 км — пассажир платит больше, но не в полтора раза.
    const ratio = paxFare(1, 3100, null, 1.1) / old(2100, 1);
    expect(ratio).toBeGreaterThan(1.1);
    expect(ratio).toBeLessThan(1.4);
  });
});
