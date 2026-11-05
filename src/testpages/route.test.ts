import { describe, expect, it } from 'vitest';
import { siteRoot, testPageName } from './route';

describe('адреса страниц: свой домен и подпапка GitHub Pages', () => {
  it('тестовая страница находится и в корне, и в подпапке', () => {
    for (const p of ['/test/bus', '/test/bus/', '/test/bus/index.html', '/roads/test/bus/', '/roads/test/bus/index.html']) {
      expect(testPageName(p), p).toBe('bus');
    }
  });

  it('игра и оглавление — не тестовая сцена', () => {
    for (const p of ['/', '/index.html', '/roads/', '/test', '/test/', '/roads/test/', '/lab.html']) {
      expect(testPageName(p), p).toBeNull();
    }
  });

  it('корень сайта по адресу любой страницы', () => {
    const cases: [string, string][] = [
      ['/', '/'],
      ['/index.html', '/'],
      ['/test', '/'],
      ['/test/', '/'],
      ['/test/index.html', '/'],
      ['/test/bus', '/'],
      ['/test/junctions/', '/'],
      ['/test/lanes', '/'],
      ['/lab.html', '/'],
      ['/roads/', '/roads/'],
      ['/roads/index.html', '/roads/'],
      ['/roads/test/', '/roads/'],
      ['/roads/test/bus/', '/roads/'],
      ['/roads/test/vehicles/index.html', '/roads/'],
      ['/roads/lab.html', '/roads/'],
    ];
    for (const [path, root] of cases) expect(siteRoot(path), path).toBe(root);
  });
});
