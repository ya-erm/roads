/**
 * Общая настройка тестов (vite.config.ts, test.setupFiles).
 *
 * После каждого теста — пауза до следующего круга событий. Поток тестов отвечает vitest (onTaskUpdate и прочие вызовы)
 * только в паузах, а тесты здесь синхронные: файл из нескольких долгих сценариев шёл минуту и больше без единой
 * паузы, ответ на вызов, отправленный перед ним, лежал необработанным, и vitest через 60 с падал с
 * «[vitest-worker]: Timeout calling "onTaskUpdate"». Теперь без пауз — не дольше одного теста.
 * setImmediate — из node:timers: vi.useFakeTimers подменяет только глобальный.
 */
import { setImmediate } from 'node:timers';
import { afterEach } from 'vitest';

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
