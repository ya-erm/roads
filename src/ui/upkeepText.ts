/**
 * Темп содержания для HUD: содержание транспорта и бригад, ремонт и проценты списываются каждую секунду
 * (Game.accrueUpkeep), поэтому «За месяц» наверху и окно «Финансы» показывают не сумму, что спишется в конце
 * месяца, а темп — сколько уходит в месяц при нынешнем парке, бригадах, сети и долге (Game.upkeepForecast).
 */
import { money } from '../core/moneyText';
import type { Ledger, UpkeepForecast } from '../game/game';

/** Темп содержания по статьям значками: «Содержание списывается каждую секунду: −$9 000 в месяц (🚌 $6 000 · …)». */
export function upkeepRateText(f: UpkeepForecast): string {
  if (f.total <= 0) return 'Содержания нет';
  const parts = [
    f.vehicles && `🚌 ${money(f.vehicles)}`,
    f.crews && `🚚 ${money(f.crews)}`,
    f.roads && `🛣 ${money(f.roads)}`,
    f.interest && `% ${money(f.interest)}`,
  ].filter(Boolean);
  return `Содержание списывается каждую секунду: −${money(f.total)} в месяц (${parts.join(' · ')})`;
}

/** Подсказка «За месяц»: что это за число и темп содержания. */
export function upkeepTip(f: UpkeepForecast): string {
  return `Доходы минус расходы с начала месяца. ${upkeepRateText(f)}`;
}

/** Темп в месяц по статьям отчёта о финансах: бригады — в «Содержании транспорта», как и в отчёте. */
export function upkeepRates(f: UpkeepForecast): Partial<Record<keyof Ledger, number>> {
  return { vehicles: f.vehicles + f.crews, roads: f.roads, interest: f.interest };
}
