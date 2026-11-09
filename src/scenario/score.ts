/**
 * Итоговая оценка сценария — не по накопленным деньгам, а по шести показателям: цели этапов, контракты,
 * сроки, финансовая эффективность, качество обслуживания и развитие региона. Сумма — до 1000, затем
 * множитель сложности (и испытания).
 */
import type { Scenario } from './manager';
import { FAST, LATE, MEDALS } from './content';
import type { Objective, ScoreLine, ScoreResult } from './types';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function computeScore(sc: Scenario): ScoreResult {
  const s = sc.state;
  const game = sc.game;
  const parts: ScoreLine[] = [];

  // Цели этапов: заработанные очки от возможных. Восстановительная попытка приносит половину, выполненное
  // с опозданием — долю LATE.points.
  const ofPhase = (o: Objective) => o.role === 'main' || o.role === 'goal';
  const share = (o: Objective) => (o.late ? LATE.points : 1);
  const phaseGoals = s.objectives.filter((o) => ofPhase(o) && !o.retryOf);
  const possible = phaseGoals.reduce((sum, o) => sum + o.points, 0);
  const earned = s.objectives.filter((o) => ofPhase(o) && o.status === 'done').reduce((sum, o) => sum + o.points * share(o), 0);
  const goalsDone = phaseGoals.filter((o) => o.status === 'done' || (o.retry && s.objectives.find((r) => r.id === o.retry)?.status === 'done')).length;
  const goalsLate = phaseGoals.filter((o) => o.status === 'done' && o.late).length;
  parts.push({
    id: 'objectives',
    name: 'Цели этапов',
    value: Math.round(400 * clamp01(possible ? earned / possible : 0)),
    max: 400,
    note: `${goalsDone} из ${phaseGoals.length}${goalsLate ? `, с опозданием ${goalsLate}` : ''}`,
  });

  // Контракты: каждый выполненный — 30 очков (с опозданием — доля LATE.points), не больше 120; сорванные отнимают по 15.
  const contracts = s.objectives.filter((o) => o.role === 'contract');
  const cDone = contracts.filter((o) => o.status === 'done');
  const cLate = cDone.filter((o) => o.late).length;
  const cFailed = contracts.filter((o) => o.status === 'failed').length;
  const cPoints = cDone.reduce((sum, o) => sum + 30 * share(o), 0);
  parts.push({
    id: 'contracts',
    name: 'Контракты',
    value: Math.round(Math.max(0, Math.min(120, cPoints - cFailed * 15))),
    max: 120,
    note: `выполнено ${cDone.length}${cLate ? ` (с опозданием ${cLate})` : ''}, сорвано ${cFailed}, предложено ${contracts.length}`,
  });

  // Сроки: насколько раньше дедлайна выполнены задания со сроком.
  const timed = s.objectives.filter((o) => o.role !== 'extra' && o.status === 'done' && o.deadline !== null && o.started !== undefined && o.closedAt !== undefined);
  const early = timed.length
    ? timed.reduce((sum, o) => sum + clamp01((o.deadline! - o.closedAt!) / Math.max(1, o.deadline! - o.started!)), 0) / timed.length
    : 0;
  parts.push({
    id: 'deadlines',
    name: 'Соблюдение сроков',
    value: Math.round(80 * clamp01(0.4 * Math.min(1, timed.length / 3) + 0.6 * early)),
    max: 80,
    note: timed.length ? `в среднем запас ${Math.round(early * 100)}% срока` : 'нет выполненных заданий со сроком',
  });

  // Быстрые сроки: доп. очки за каждое задание, выполненное к быстрому сроку (есть только у части заданий).
  const fastOnes = s.objectives.filter((o) => o.role !== 'extra' && o.fast !== undefined);
  if (fastOnes.length) {
    const quick = fastOnes.filter((o) => o.quick).length;
    const max = Math.min(FAST.maxPoints, fastOnes.length * FAST.points);
    parts.push({
      id: 'fast',
      name: 'Быстрые сроки',
      value: Math.min(max, quick * FAST.points),
      max,
      note: `успели к быстрому сроку ${quick} из ${fastOnes.length}`,
    });
  }

  // Финансы: операционная маржа за весь сценарий (перевозки минус содержание, ремонт и проценты).
  const income = s.stats.months.reduce((sum, m) => sum + m.income, 0);
  const costs = s.stats.months.reduce((sum, m) => sum + m.costs, 0);
  const margin = income > 0 ? (income - costs) / income : -1;
  parts.push({
    id: 'finance',
    name: 'Финансовая эффективность',
    value: Math.round(150 * clamp01(margin / 0.5)),
    max: 150,
    note: income > 0 ? `маржа ${Math.round(margin * 100)}%${game.loan > 0 ? `, кредит $${game.loan.toLocaleString('ru-RU')}` : ''}` : 'перевозок не было',
  });

  // Качество: средняя надбавка за скорость по объёму и закрытые потребности городов.
  const units = s.stats.months.reduce((sum, m) => sum + m.units, 0);
  const speed = units > 0 ? s.stats.months.reduce((sum, m) => sum + m.units * m.speed, 0) / units : 0.8;
  const pop = game.towns.reduce((sum, t) => sum + t.population, 0);
  const supply = pop > 0 ? game.towns.reduce((sum, t) => sum + t.population * game.townSatisfaction(t), 0) / pop : 0;
  parts.push({
    id: 'quality',
    name: 'Качество обслуживания',
    value: Math.round(70 * clamp01((speed - 0.9) / 0.4) + 30 * supply),
    max: 100,
    note: `скорость ×${speed.toFixed(2)}, снабжение ${Math.round(supply * 100)}%`,
  });

  // Регион: рост населения и производства с начала сценария.
  const growth = s.start.population > 0 ? pop / s.start.population - 1 : 0;
  const levels = game.industries.reduce((sum, i) => sum + (i.level ?? 1), 0);
  const industry = game.industries.length ? (levels - s.start.levels) / game.industries.length : 0;
  parts.push({
    id: 'region',
    name: 'Развитие региона',
    value: Math.round(90 * clamp01(growth / 0.4) + 60 * clamp01(industry / 0.75)),
    max: 150,
    note: `население ${growth >= 0 ? '+' : ''}${Math.round(growth * 100)}%, производство +${industry.toFixed(2)} ур.`,
  });

  const won = s.status === 'won';
  const raw = parts.reduce((sum, p) => sum + p.value, 0);
  const multiplier = sc.multiplier;
  const total = Math.round(raw * multiplier * (won ? 1 : 0.7));
  const medal = !won ? null : total >= MEDALS.gold ? 'gold' : total >= MEDALS.silver ? 'silver' : total >= MEDALS.bronze ? 'bronze' : null;
  return { total, medal, parts, multiplier, won };
}
