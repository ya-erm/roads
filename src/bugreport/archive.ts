/**
 * Отчёт одним архивом (значок скачивания в окне баг-репорта): снимок, журнал, сохранение, схема участка
 * (area.json — шаблон развязки) — что приложено,
 * report.md — текст отчёта с именем и описанием, meta.json — сведения об игре и окружении для разбора.
 * Здесь только содержимое; сам ZIP пишет zip.ts.
 */

import { localStamp, reportMarkdown, reportStem, type AttachKind, type ReportFile, type ReportInfo } from './report';
import type { ZipEntry } from './zip';

/** Имена файлов внутри архива. */
export const ARCHIVE_FILES = {
  shot: 'screenshot.png',
  journal: 'journal.jsonl',
  save: 'save.json',
  area: 'area.json',
  report: 'report.md',
  meta: 'meta.json',
} as const;

export interface ArchiveInput {
  info: ReportInfo;
  /** PNG снимка с пометками — если снимок приложен. */
  shot?: Uint8Array;
  journal?: string;
  save?: string;
  /** Схема участка — файл шаблона развязки (bugreport/areaTemplate.ts), если участок отмечен. */
  area?: string;
}

/** Сведения для разбора: кто, когда, какая версия и сборка, партия, экран, место на карте и браузер, что приложено. */
export function reportMeta(info: ReportInfo, attached: AttachKind[]) {
  const author = info.author?.trim();
  return {
    app: 'razvyazka',
    ...(author ? { author } : {}),
    description: info.description.trim(),
    created: info.at.toISOString(),
    localTime: localStamp(info.at),
    game: {
      version: info.version,
      build: info.build,
      saveVersion: info.saveVersion,
      date: info.date,
      seed: info.seed,
      ...(info.scenario ? { scenario: info.scenario } : {}),
    },
    screen: info.screen,
    // Где на карте: камера игрока, видимая часть карты и участок (как --camera и --area у npm run shot).
    ...(info.spot ? { map: info.spot } : {}),
    page: info.page,
    userAgent: info.userAgent,
    files: attached.map((k) => ARCHIVE_FILES[k]),
  };
}

/** Файлы архива: сначала текст и сведения, затем приложенное. */
export function archiveEntries(input: ArchiveInput): ZipEntry[] {
  const enc = new TextEncoder();
  const attached: { kind: AttachKind; data: Uint8Array }[] = [];
  if (input.shot) attached.push({ kind: 'shot', data: input.shot });
  if (input.journal !== undefined) attached.push({ kind: 'journal', data: enc.encode(input.journal) });
  if (input.save !== undefined) attached.push({ kind: 'save', data: enc.encode(input.save) });
  if (input.area !== undefined) attached.push({ kind: 'area', data: enc.encode(input.area) });
  const files: ReportFile[] = attached.map((a) => ({ kind: a.kind, name: ARCHIVE_FILES[a.kind] }));
  const kinds = attached.map((a) => a.kind);
  return [
    { name: ARCHIVE_FILES.report, data: enc.encode(`${reportMarkdown(input.info, files)}\n`) },
    { name: ARCHIVE_FILES.meta, data: enc.encode(`${JSON.stringify(reportMeta(input.info, kinds), null, 2)}\n`) },
    ...attached.map((a) => ({ name: ARCHIVE_FILES[a.kind], data: a.data })),
  ];
}

/** «razvyazka-bug-2026-11-06-090507.zip». */
export function archiveName(at: Date): string {
  return `${reportStem(at)}.zip`;
}
