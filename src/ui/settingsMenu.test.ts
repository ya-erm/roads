import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Меню → Настройки', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('по строке-переключателю на каждую настройку: значок, название, пояснение и нынешнее положение', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', undefined);
    const { PREFS, overridePref } = await import('./prefs');
    const { settingsHtml, settingsSvg } = await import('./settingsMenu');
    expect(settingsSvg()).toContain('<svg');
    overridePref('junctionMarks', false);
    const off = settingsHtml();
    expect(off.match(/data-action="pref"/g)).toHaveLength(PREFS.length);
    for (const p of PREFS) {
      expect(off).toContain(`data-id="${p.id}"`);
      expect(off).toContain(p.name);
      expect(off).toContain(p.hint);
    }
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(off).not.toMatch(/флаг/i);
    overridePref('junctionMarks', true);
    const on = settingsHtml();
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('menu-item pref on');
  });
});
