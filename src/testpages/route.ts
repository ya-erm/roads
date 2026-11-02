/** Тестовая страница по адресу: /test/bus, /test/bus/ → 'bus'; обычная игра — null. */
export function testPageName(pathname: string): string | null {
  const m = /^\/test\/([\w-]+)\/?(?:index\.html)?$/.exec(pathname);
  return m ? m[1] : null;
}
