import { describe, expect, it } from 'vitest';
import { thanksHtml, type Sent } from './bugReport';

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
