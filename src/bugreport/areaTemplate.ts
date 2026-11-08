/**
 * Схема участка для баг-репорта: дороги и пути внутри рамки «Участок» (или того, что обведено пометками) —
 * тем же кодом, что копирование рамкой (Game.copyArea), и в том же формате, что «Скачать шаблон файлом»
 * (game/templates.ts). Файл area.json открывается в игре «Развязки → Шаблон → Открыть шаблоны из файла»
 * и вставляется как свой шаблон в любую партию — хоть в пустую.
 * Без DOM: копирование передаётся снаружи.
 */

import type { Vec } from '../core/vec';
import { fragmentToFile } from '../game/templates';
import type { Fragment } from '../lanes/fragment';
import type { MapSpot, WorldBox } from './spot';

/** Копия дорог и путей в рамке между углами a и b (как Game.copyArea); null — копировать нечего. */
export type CopyArea = (a: Vec, b: Vec) => Fragment | null;

/** Схема участка: кусок сети, имя шаблона и текст файла. */
export interface AreaTemplate {
  name: string;
  fragment: Fragment;
  /** Текст файла шаблонов (TemplateFile) с одним шаблоном. */
  text: string;
}

/**
 * Участок, по которому собирают схему: отмечен рамкой или обведён пометками. Участок «по кадру» — нет:
 * кадр снимка выбирают для картинки, а не чтобы показать место.
 */
export function schemeBox(spot: MapSpot | undefined): WorldBox | null {
  if (!spot?.area || (spot.source !== 'frame' && spot.source !== 'marks')) return null;
  return spot.area;
}

/** «Участок из отчёта 08.11 02:21» — имя шаблона (влезает в 40 знаков имени шаблона). */
export function schemeName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Участок из отчёта ${p(at.getDate())}.${p(at.getMonth() + 1)} ${p(at.getHours())}:${p(at.getMinutes())}`;
}

/** Схема участка отчёта; участок не отмечен или в нём нет дорог и путей — null. */
export function areaTemplate(copy: CopyArea, spot: MapSpot | undefined, at: Date): AreaTemplate | null {
  const box = schemeBox(spot);
  if (!box) return null;
  const fragment = copy({ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y1 });
  if (!fragment || (!fragment.corridors.length && !fragment.rail?.segs.length)) return null;
  const name = schemeName(at);
  return { name, fragment, text: fragmentToFile(name, fragment, at.getTime()).text };
}

/** «3 дороги · 2 пути» — что в схеме, для строки файлов. */
export function schemeNote(frag: Fragment): string {
  const roads = frag.corridors.length;
  const rails = frag.rail?.segs.length ?? 0;
  const parts = [roads ? `${roads} ${plural(roads, 'дорога', 'дороги', 'дорог')}` : '', rails ? `${rails} ${plural(rails, 'путь', 'пути', 'путей')}` : ''];
  return parts.filter(Boolean).join(' · ');
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
