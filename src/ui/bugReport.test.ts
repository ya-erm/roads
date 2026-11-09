import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUG_REPORT } from '../config';
import { submitReport, uploadAttachments, xhrPost, type Attachment, type ReportFile } from '../bugreport/report';
import { deliverReport, thanksHtml, type SendSteps, type Sent } from './bugReport';

const sent = (over: Partial<Sent> = {}): Sent => ({
  text: 'отчёт',
  receipt: { id: '7', number: 7, url: 'https://board.example/t/7' },
  error: '',
  uploaded: [],
  uploadError: '',
  copied: false,
  ...over,
});

/** Кнопки и ссылки экрана, у которых data-bug="close" — по ним окно закрывается (onClick → close). */
const closers = (html: string) => [...html.matchAll(/<button([^>]*)data-bug="close"([^>]*)>([^<]*)</g)].map((m) => ({ attrs: m[1] + m[2], label: m[3] }));

describe('Экран «Спасибо за отчёт»', () => {
  it('крестик в углу закрывает окно, как и «Вернуться в игру»', () => {
    const html = thanksHtml(sent());
    const c = closers(html);
    expect(c).toHaveLength(2);
    const x = c.find((b) => b.label === '✕')!;
    // Тот же вид, что у крестика окна отчёта, и своё место в углу экрана благодарности.
    expect(x.attrs).toContain('class="bug-x bug-thanks-x"');
    expect(x.attrs).toContain('data-tip="Закрыть (Esc)"');
    expect(x.attrs).toContain('data-tip-end');
    expect(c.some((b) => b.label === 'Вернуться в игру')).toBe(true);
    // Крестик — первым: в углу поверх картинки, а не после кнопок.
    expect(html.trimStart().startsWith('<button class="bug-x bug-thanks-x"')).toBe(true);
  });

  it('подсказки — свои, без системных title', () => {
    for (const s of [sent(), sent({ uploaded: null, uploadError: 'Нет места' })]) expect(thanksHtml(s)).not.toMatch(/\stitle="/);
  });

  it('файлы не приложились — крестик на месте, рядом кнопка архива', () => {
    const html = thanksHtml(sent({ uploaded: null, uploadError: 'Нет места.' }));
    expect(html).toContain('bug-thanks-x');
    expect(html).toContain('не приложились: нет места.');
    expect(html).toContain('data-bug="archive"');
  });
});

describe('Отправка отчёта (deliverReport): окно не остаётся в «отправляю»', () => {
  const shot: Attachment = { kind: 'shot', name: 'a.png', type: 'image/png', data: new Blob([new Uint8Array(10)]) };

  /** Шаги отправки с журналом: busy — как кнопка «Отправить» (true — бледная), status — строка над ней. */
  function steps(over: Partial<SendSteps> = {}) {
    const log = { busy: [] as boolean[], status: [] as string[], submitted: [] as ReportFile[][] };
    const s: SendSteps = {
      busy: (on) => log.busy.push(on),
      status: (t) => log.status.push(t),
      files: async () => [shot],
      upload: async () => [{ kind: 'shot', name: 'a.png', url: 'https://board/a.webp', size: 10 }],
      submit: async (refs) => {
        log.submitted.push(refs);
        return { id: '1', number: 1 };
      },
      text: (refs) => refs.map((r) => r.url ?? r.name).join(' '),
      copy: async () => true,
      ...over,
    };
    /** Кнопка «Отправить» активна: последнее busy — false. */
    const active = () => log.busy.at(-1) === false;
    return { s, log, active };
  }

  // Отказы отправка пишет в console.warn — в тестах молча.
  let warn: { mockRestore: () => void } | undefined;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warn?.mockRestore();
  });

  it('всё дошло — квитанция, файлы со ссылками, кнопка снова активна', async () => {
    const { s, log, active } = steps();
    const sent = await deliverReport(s);
    expect(sent).toMatchObject({ receipt: { id: '1' }, error: '', uploadError: '', copied: false });
    expect(log.busy).toEqual([true, false]);
    expect(active()).toBe(true);
    expect(log.status).toEqual(['Готовлю файлы…', 'Загружаю файлы…', 'Отправляю отчёт на доску…']);
  });

  it('preflight загрузчика не прошёл (TypeError, как у fetch и xhr.onerror) — карточка уходит без файлов, кнопка активна', async () => {
    const { s, log, active } = steps({
      upload: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const sent = await deliverReport(s);
    expect(sent.uploaded).toBeNull();
    expect(sent.uploadError).toBe('нет связи с загрузчиком доски');
    expect(log.submitted[0]).toEqual([{ kind: 'shot', name: 'a.png', url: undefined }]);
    expect(sent.receipt).not.toBeNull();
    expect(active()).toBe(true);
  });

  it('и доска не пустила — понятная ошибка, текст в буфер, можно отправить ещё раз', async () => {
    const { s, active } = steps({
      upload: async () => {
        throw new TypeError('Failed to fetch');
      },
      submit: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const sent = await deliverReport(s);
    expect(sent).toMatchObject({ receipt: null, error: 'нет связи с доской задач', copied: true, text: 'a.png' });
    expect(active()).toBe(true);
  });

  it('загрузчик и доска молчат — через BUG_REPORT.stallMs на каждый запрос ошибка «не отвечает», кнопка активна', async () => {
    vi.useFakeTimers();
    // Настоящие загрузка и отправка, а fetch и XMLHttpRequest — без единого ответа.
    const silent = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    class SilentXhr {
      upload = {};
      open() {}
      setRequestHeader() {}
      send() {}
      abort() {}
    }
    const { s, log, active } = steps({
      upload: (files) => uploadAttachments(files, { fetch: silent, post: xhrPost(SilentXhr as unknown as { new (): XMLHttpRequest }) }),
      submit: () => submitReport({ description: 'x', sourceKey: 'k' }, { fetch: silent }),
    });
    let sent: Sent | undefined;
    void deliverReport(s).then((r) => (sent = r));
    await vi.advanceTimersByTimeAsync(BUG_REPORT.stallMs);
    // Файлы не дождались — карточка пошла без них, кнопка ещё бледная.
    expect(log.status.at(-1)).toBe('Отправляю отчёт на доску…');
    expect(active()).toBe(false);
    await vi.advanceTimersByTimeAsync(BUG_REPORT.stallMs);
    expect(sent).toMatchObject({ receipt: null, uploaded: null, error: 'Доска не отвечает дольше 60 с', uploadError: 'Доска не отвечает дольше 60 с' });
    expect(active()).toBe(true);
  });

  it('файлы не собрались (снимок упал) — отказ без отправки, кнопка активна', async () => {
    const submit = vi.fn();
    const { s, active } = steps({
      files: async () => {
        throw new Error('PNG не собрался');
      },
      submit,
    });
    const sent = await deliverReport(s);
    expect(sent.receipt).toBeNull();
    expect(sent.error).toBe('не удалось собрать файлы отчёта');
    expect(submit).not.toHaveBeenCalled();
    expect(active()).toBe(true);
  });

  it('буфер обмена не ответил — не ждём его вечно', async () => {
    vi.useFakeTimers();
    const { s, active } = steps({
      submit: async () => {
        throw new TypeError('Failed to fetch');
      },
      copy: () => new Promise<boolean>(() => {}),
    });
    let sent: Sent | undefined;
    void deliverReport(s).then((r) => (sent = r));
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent?.copied).toBe(false);
    expect(active()).toBe(true);
  });
});
