import type { IndustryType } from './cargo';
import type { CargoType } from './cargo';
import type { Plot } from './spatial';

export type SitePoint = readonly [number, number];
export type SectionKind = 'field' | 'paddock' | 'pit' | 'well' | 'workshop' | 'warehouse' | 'receiving' | 'utilities' | 'service' | 'pond';

export interface CompoundSection {
  kind: SectionKind;
  /** Прямоугольник в долях ширины и высоты главного корпуса. */
  bounds: readonly [left: number, top: number, right: number, bottom: number];
  gate?: SitePoint;
  cargo?: CargoType;
}

export interface CompoundPlan {
  sections: readonly CompoundSection[];
  main: readonly SitePoint[];
  branches: readonly (readonly SitePoint[])[];
}

export const INDUSTRY_ROAD_WIDTH = 9;

function rect(kind: SectionKind, bounds: CompoundSection['bounds'], gate?: SitePoint): CompoundSection {
  return { kind, bounds, ...(gate && { gate }) };
}

export function sectionPlot(section: CompoundSection): Plot {
  const [l, t, r, b] = section.bounds;
  const x = Math.min((r - l) / 12, 0.035);
  const y = Math.min((b - t) / 12, 0.035);
  return [
    { x: l + x, y: t }, { x: r - x, y: t }, { x: r, y: t + y }, { x: r, y: b - y },
    { x: r - x, y: b }, { x: l + x, y: b }, { x: l, y: b - y }, { x: l, y: t + y },
  ];
}

/** Сельские дороги проходят между большими прямоугольными участками и подходят к фермерскому двору с юга. */
export function farmCompound(paddocks: boolean, complete: boolean): CompoundPlan {
  const sections: CompoundSection[] = [];
  const field = paddocks ? 'paddock' : 'field';
  const roadY = 0.335;
  if (!complete) return {
    sections: [rect(field, [-1.37, -0.90, -0.22, 0.17], [-0.8, 0.17])],
    main: [[-0.8, roadY], [0.90, roadY]],
    branches: [[[-0.8, roadY], [-0.8, 0.17]]],
  };
  const rows = [[-1.91, -1.04], [-0.90, 0.17], [0.41, 1.53]] as const;
  for (const [top, bottom] of rows) {
    sections.push(rect(field, [-2.72, top, -1.58, bottom], [-1.58, (top + bottom) / 2]));
    sections.push(rect(field, [-1.37, top, -0.22, bottom], [-1.37, (top + bottom) / 2]));
  }
  sections.push(rect('service', [0.08, -1.04, 0.51, -0.58], [0.51, -0.80]));
  sections.push(rect('warehouse', [0.10, 0.57, 0.52, 1.05], [0.36, 0.57]));
  return {
    sections,
    main: [[-1.475, roadY], [0.90, roadY]],
    branches: [
      [[-1.475, rows[0][0]], [-1.475, rows[2][1]]],
      ...rows.flatMap(([top, bottom]) => {
        const y = (top + bottom) / 2;
        return [[[-1.58, y], [-1.37, y]] as const];
      }),
      [[0.67, roadY], [0.67, -0.80], [0.51, -0.80]],
      [[0.36, roadY], [0.36, 0.57]],
    ],
  };
}

/** У переработчика — улица перед главным корпусом, по сторонам самостоятельные дворы сырья и отгрузки. */
export function worksCompound(info: IndustryType, openPit: boolean, power: boolean, complete: boolean): CompoundPlan {
  const front = openPit ? 0.75 : 0.76;
  const mineEntry: SitePoint = [24 / info.w, (info.kind === 'quarry' ? 25 : 24) / info.h];
  const worksGate = (openPit ? mineEntry[0] : 0.13);
  const coreDrive: readonly SitePoint[] = [[worksGate, front], openPit ? mineEntry : [worksGate, 0.51]];
  if (!complete) return { sections: [], main: [[worksGate, front], [1.49, front]], branches: [coreDrive] };
  const sections: CompoundSection[] = [
    rect(openPit ? 'pond' : 'receiving', [-1.28, -0.36, -0.68, 0.20], [-0.98, 0.20]),
    rect(openPit ? 'workshop' : 'service', [-1.28, 0.35, -0.68, 0.63], [-0.98, 0.63]),
    rect('warehouse', [0.64, 0.15, 1.14, 0.53], [0.89, 0.53]),
    rect(power ? 'utilities' : 'workshop', [0.64, -0.51, 1.14, -0.01], [1.14, -0.25]),
  ];
  if (info.accepts[0] && !openPit) sections[0].cargo = info.accepts[0];
  if (info.accepts[1]) sections.push({ ...rect('receiving', [0.64, -1.17, 1.14, -0.65], [1.14, -0.91]), cargo: info.accepts[1] });
  return {
    sections,
    main: [[-0.98, front], [0.88, front], [1.25, front], [1.49, front]],
    branches: [
      [[-0.98, front], [-0.98, 0.63]],
      [[-0.63, front], [-0.63, 0.26], [-0.98, 0.26], [-0.98, 0.20]],
      [[0.89, front], [0.89, 0.53]],
      [[1.25, front], [1.25, -0.25], [1.14, -0.25]],
      ...(info.accepts[1] ? [[[1.25, -0.25], [1.25, -0.91], [1.14, -0.91]] as const] : []),
      // У карьеров въезд идёт к площадке разгрузки у съезда, у переработчика — в проём у погрузки.
      coreDrive,
    ],
  };
}
