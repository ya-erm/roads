/**
 * Замер «машин из ниоткуда» (docs/PARKING.md, game/carFlow.ts): доля появлений машин жителей у узла (а не с места —
 * гаража, площадки, двора, бокса, стоянки магазина) и доля исчезновений у узла — по seed и размерам карт, за
 * несколько минут игры с начала партии (настройки новой игры).
 *
 *   npx vite-node scripts/car-flow.ts                      — seed 1…3, средняя и большая, 3 минуты
 *   npx vite-node scripts/car-flow.ts -- 2 medium 60       — seed 1…2, средняя, 60 с
 *   npx vite-node scripts/car-flow.ts -- 3 180 180         — 3 минуты после 3 минут разгона (машины уже в разъездах)
 */
import { watchCarFlow, nowhereShare } from '../src/game/carFlow';
import { Game } from '../src/game/game';
import { MAP_SIZES, NEW_GAME_SETTINGS, type MapSize } from '../src/world/settings';

const args = process.argv.slice(2).filter((a) => a !== '--');
const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
const seeds = nums[0] ?? 3;
const seconds = nums[1] ?? 180;
const warm = nums[2] ?? 0;
const picked = args.filter((a) => a in MAP_SIZES) as MapSize[];
const sizes = picked.length ? picked : (['medium', 'large'] as MapSize[]);
const pct = (x: number) => `${Math.round(x * 100)}%`;

// Доля у узла — все машины жителей; «без парка» — без машин парка (carHomes.ts), что едут от цели домой и встали у цели.
const rows: string[] = [
  '| карта | seed | появились у узла | с места | доля у узла | без парка | исчезли у узла | на месте | доля у узла | без парка |',
  '|---|---|---|---|---|---|---|---|---|---|',
];
const sums = new Map<MapSize, { a: number; v: number; ai: number; vo: number; n: number }>();
for (const size of sizes) {
  for (let seed = 1; seed <= seeds; seed++) {
    const t0 = Date.now();
    const game = new Game({ ...NEW_GAME_SETTINGS, seed, size });
    game.speed = 1;
    for (let t = 0; t < warm; t += 0.1) game.update(0.1);
    const w = watchCarFlow(game);
    for (let t = 0; t < seconds; t += 0.1) {
      game.update(0.1);
      w.frame();
    }
    const f = w.flow;
    const s = nowhereShare(f);
    const sum = sums.get(size) ?? { a: 0, v: 0, ai: 0, vo: 0, n: 0 };
    sums.set(size, { a: sum.a + s.appear, v: sum.v + s.vanish, ai: sum.ai + s.nowhereIn, vo: sum.vo + s.nowhereOut, n: sum.n + 1 });
    rows.push(
      `| ${size} | ${seed} | ${f.nodeIn} | ${f.placeIn} | ${pct(s.appear)} | ${pct(s.nowhereIn)} | ${f.nodeOut + f.lost} | ${f.placeOut} | ${pct(s.vanish)} | ${pct(s.nowhereOut)} |`,
    );
    console.error(`${size} seed ${seed}: ${Math.round((Date.now() - t0) / 1000)} с`);
  }
}
for (const [size, s] of sums) rows.push(`| ${size} | среднее | | | ${pct(s.a / s.n)} | ${pct(s.ai / s.n)} | | | ${pct(s.v / s.n)} | ${pct(s.vo / s.n)} |`);
console.log(rows.join('\n'));
