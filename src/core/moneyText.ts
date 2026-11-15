/**
 * Деньги в интерфейсе: «$12 345», в минусе — «−$958 580» (типографский минус перед знаком доллара,
 * как в окне «Финансы»), а не «$-958 580», как вышло бы у toLocaleString. Округление — до доллара.
 */
export function money(n: number): string {
  const r = Math.round(n);
  return `${r < 0 ? '−' : ''}$${Math.abs(r).toLocaleString('ru-RU')}`;
}
