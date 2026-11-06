/**
 * Диагностика сценариев: генерирует много сценариев на разных seed, размерах карт, сложностях и биомах
 * (по кругу) и проверяет базовую выполнимость — каждое задание этапов A, B и C (B и C — как если бы этап
 * пропустили на пустой сети) проходит feasibility.assess, а стартового капитала с кредитом хватает на главную цель.
 *
 *   npm run scenarios            — 30 seed
 *   npm run scenarios -- 100     — 100 seed
 *   npm run scenarios -- 20 -v   — с перечнем заданий
 *   npm run scenarios -- --legacy — старые миры без биома
 *
 * Код выхода 1, если нашлись невыполнимые задания или не хватает денег.
 */
import { TERM_SCALE } from '../src/config';
import { dist } from '../src/core/vec';
import { Game } from '../src/game/game';
import { MODELS } from '../src/game/transport';
import { posOf, resolve, routeCost, townById } from '../src/scenario/analysis';
import { assess } from '../src/scenario/feasibility';
import type { Scenario } from '../src/scenario/manager';
import type { ArchetypeId, Difficulty, Objective } from '../src/scenario/types';
import { BIOME_LIST } from '../src/world/biomes';
import { DEFAULT_SETTINGS, MapSize } from '../src/world/settings';

const args = process.argv.slice(2);
const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);
const verbose = args.includes('-v');
/** --legacy — старые миры без биома (средняя полоса до биомов); иначе биомы по кругу. */
const legacy = args.includes('--legacy');
const sizes: MapSize[] = ['small', 'medium', 'large'];
const difficulties: Difficulty[] = ['easy', 'normal', 'hard'];

interface Problem {
  seed: number;
  where: string;
  text: string;
}

const problems: Problem[] = [];
const biomes = new Map<string, number>();
const archetypes = new Map<string, number>();
const refits = new Map<string, number>();
const mainKinds = new Map<string, number>();
let scenarios = 0;
let objectives = 0;
let time = 0;

/** Стоимость главной цели этапа A по прямой: дорога, станции, машины. */
function mainCost(game: Game, o: Objective): number | null {
  const p = o.params;
  if (p.kind === 'passengers' && p.towns) {
    const [a, b] = p.towns.map((id) => townById(game, id)!);
    return routeCost(dist(a.center, b.center), 2, 'bus');
  }
  if (p.kind === 'deliver' && p.to) {
    const to = resolve(game, p.to);
    if (!to) return null;
    const from = game.industries.filter((i) => i.info.produces === p.cargo).sort((x, y) => dist(x.fp.center, posOf(to)) - dist(y.fp.center, posOf(to)))[0];
    return from ? routeCost(dist(from.fp.center, posOf(to)), 3, 'truck') : null;
  }
  return MODELS.bus.price * 2;
}

function check(sc: Scenario, seed: number, phase: number): void {
  for (const o of sc.state.objectives.filter((x) => x.phase === phase || (phase === 0 && x.phase === null))) {
    objectives++;
    const months = o.months ?? (o.deadline !== null ? o.deadline - o.created : 24 * TERM_SCALE);
    const v = assess(sc.game, o.params, months);
    if (!v.ok) problems.push({ seed, where: `этап ${'ABC'[phase]}`, text: `${o.title}: ${v.reason}` });
    if (verbose) console.log(`    ${'ABC'[phase]} ${o.role.padEnd(8)} ${v.ok ? '✓' : '✗'} ${o.title}${v.estimate ? ` (оценка ${Math.round(v.estimate)})` : ''}`);
  }
}

function skipPhase(sc: Scenario): boolean {
  const main = sc.state.objectives.filter((o) => o.phase === sc.state.phase && o.role === 'main').pop();
  if (!main) return false;
  main.status = 'done';
  return sc.advancePhase();
}

for (let i = 0; i < count; i++) {
  const seed = 1000 + i * 7919;
  const size = sizes[i % sizes.length];
  const difficulty = difficulties[Math.floor(i / sizes.length) % difficulties.length];
  // Биомов пять, размеров три: за 15 seed встречается каждое сочетание биома и размера.
  const biome = legacy ? undefined : BIOME_LIST[i % BIOME_LIST.length].id;
  const t0 = performance.now();
  const game = new Game({ ...DEFAULT_SETTINGS, seed, size, biome, scenario: { difficulty, challenge: false } });
  time += performance.now() - t0;
  const sc = game.scenario!;
  scenarios++;
  biomes.set(biome ?? 'без биома', (biomes.get(biome ?? 'без биома') ?? 0) + 1);
  const before = problems.length;
  const planned = game.settings.scenario!.archetype as ArchetypeId;
  archetypes.set(sc.state.archetype, (archetypes.get(sc.state.archetype) ?? 0) + 1);
  if (planned !== sc.state.archetype) refits.set(`${planned} → ${sc.state.archetype}`, (refits.get(`${planned} → ${sc.state.archetype}`) ?? 0) + 1);
  const main = sc.state.objectives.find((o) => o.role === 'main' && o.phase === 0)!;
  mainKinds.set(main.params.kind, (mainKinds.get(main.params.kind) ?? 0) + 1);
  if (verbose) console.log(`\nseed ${seed} · ${size} · ${biome ?? 'без биома'} · ${difficulty} · ${sc.state.archetype} · капитал $${game.money.toLocaleString('ru-RU')} · кредит $${game.loan.toLocaleString('ru-RU')}`);
  const cost = mainCost(game, main);
  if (cost !== null && cost > game.money + game.loanMax - game.loan) {
    problems.push({ seed, where: 'старт', text: `главная цель стоит ≈$${cost.toLocaleString('ru-RU')}, а денег с кредитом $${(game.money + game.loanMax - game.loan).toLocaleString('ru-RU')}` });
  }
  check(sc, seed, 0);
  if (skipPhase(sc)) check(sc, seed, 1);
  else problems.push({ seed, where: 'этап B', text: 'не удалось перейти' });
  if (skipPhase(sc)) check(sc, seed, 2);
  else problems.push({ seed, where: 'этап C', text: 'не удалось перейти' });
  for (const p of problems.slice(before)) p.where = `${biome ?? 'без биома'} · ${size} · ${p.where}`;
}

const list = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '—';
console.log(`\nСценариев: ${scenarios}, заданий проверено: ${objectives}, генерация мира со сценарием: ${(time / scenarios).toFixed(0)} мс в среднем`);
console.log(`Биомы: ${list(biomes)}`);
console.log(`Архетипы: ${list(archetypes)}`);
console.log(`Карта не подошла под архетип: ${list(refits)}`);
console.log(`Главная цель этапа A: ${list(mainKinds)}`);
if (problems.length) {
  console.log(`\nПроблемы (${problems.length}):`);
  for (const p of problems) console.log(`  seed ${p.seed} · ${p.where}: ${p.text}`);
  process.exit(1);
}
console.log('\nВсе задания выполнимы, стартовых денег хватает.');
