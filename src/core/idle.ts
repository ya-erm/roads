/**
 * Дело на простой браузера (requestIdleCallback; нет его — setTimeout): не в том кадре, где его попросили.
 * Возвращает «попросить»: повторные просьбы, пока дело ждёт, — то же одно дело. timeout — не позже стольких
 * миллисекунд, даже если простоя нет (игра рисует каждый кадр).
 */
export function idleOnce(fn: () => void, timeout = 2000): () => void {
  let pending = false;
  const run = () => {
    pending = false;
    fn();
  };
  return () => {
    if (pending) return;
    pending = true;
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout });
    else setTimeout(run, 0);
  };
}
