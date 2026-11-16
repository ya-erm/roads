/**
 * Закрытая модель в карточке маршрута (game/unlocks.ts): вместо срока — полоска пути до порога и счёт значком
 * «👤 1 240 / 2 000» или «📦 380 / 400»; подробности — в подсказке data-tip.
 */
import { money } from '../core/moneyText';
import { MODELS, type ModelId, modelName } from '../game/transport';
import { FAMILY_TEXT, familyIcon, type UnlockProgress } from '../game/unlocks';

const num = (n: number) => Math.floor(n).toLocaleString('ru-RU');

/** Полоска прогресса и счёт под названием закрытой модели. */
export function unlockProgressHtml(p: UnlockProgress): string {
  const pct = Math.round(p.share * 1000) / 10;
  return `<i class="unlock-bar"><i style="width:${pct}%"></i></i><small class="unlock-count">${familyIcon(p.family)} ${num(p.have)} / ${num(p.need)}</small>`;
}

/** Подсказка закрытой карточки: кто сколько должен перевезти, сколько осталось, что даст модель. */
export function unlockTip(id: ModelId, p: UnlockProgress, tank = false): string {
  const m = MODELS[id];
  const { who, unit } = FAMILY_TEXT[p.family];
  const left = Math.max(0, p.need - p.have);
  return `🔒 ${modelName(id, tank)} откроется, когда ${who} перевезут ${num(p.need)} ${unit} · осталось ${num(left)} · ${m.capacity} мест · ${money(m.price)}`;
}
