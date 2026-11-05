/**
 * Тестовая страница по адресу: /test/bus, /test/bus/ → 'bus'; обычная игра — null. Сайт может лежать
 * в подпапке (ya-erm.github.io/roads/test/bus/), поэтому смотрим на конец адреса, а не на начало.
 */
export function testPageName(pathname: string): string | null {
  const m = /\/test\/([\w-]+)\/?(?:index\.html)?$/.exec(pathname);
  return m ? m[1] : null;
}

/**
 * Корень сайта по адресу любой его страницы, со слешем на конце: '/' на своём домене и в dev,
 * '/roads/' на ya-erm.github.io/roads/. Понимает игру (/, /index.html), оглавление (/test, /test/),
 * тестовые страницы (/test/bus/) и лабораторию (/lab.html, /test/lanes на dev-сервере).
 */
export function siteRoot(pathname: string): string {
  const m = /^(.*?\/)(?:index\.html|lab\.html|test(?:\/[\w-]+)?\/?(?:index\.html)?)?$/.exec(pathname);
  return m ? m[1] : '/';
}
