import type { Vec } from '../core/vec';
import { LaneNet, oneWay, slot, twoWay } from './model';

export interface Lab {
  net: LaneNet;
  titles: { pos: Vec; text: string }[];
  /** Тупики, из которых машины выезжают реже (во столько раз). */
  sparse: Map<number, number>;
}

const EAST = { x: 1, y: 0 };

/** Примеры для лаборатории полос: каждый — в своей полосе карты, сверху вниз. */
export function buildLab(): Lab {
  const net = new LaneNet();
  const titles: Lab['titles'] = [];
  const sparse = new Map<number, number>();
  const title = (x: number, y: number, text: string) => titles.push({ pos: { x, y }, text });
  const seam = (x: number, y: number, dir: Vec = EAST) => net.addSeam({ x, y }, dir);

  // Съезд с крайней полосы: магистраль 2+2 расширяется до трёх полос, крайняя уходит в съезд.
  let y = 0;
  title(-650, y - 90, 'Третья полоса уходит в съезд');
  {
    const a = seam(-650, y);
    const s = seam(0, y);
    net.addCorridor(a.id, s.id, { cls: 'highway', lanes: [...twoWay(2, 2), slot(17.5, 1, 330)] });
    net.addCorridor(s.id, seam(650, y).id, { cls: 'highway', lanes: twoWay(2, 2) });
    net.addCorridor(s.id, seam(560, y + 230, { x: 1, y: 0.25 }).id, { cls: 'highway', portA: 17.5, lanes: oneWay(1) });
  }

  // Въезд: съезд вливается полосой разгона, она сужается, и машины перестраиваются.
  y = 650;
  title(-650, y - 90, 'Въезд с полосой разгона');
  {
    const s = seam(0, y);
    net.addCorridor(seam(-650, y).id, s.id, { cls: 'highway', lanes: twoWay(2, 2) });
    net.addCorridor(s.id, seam(650, y).id, { cls: 'highway', lanes: [...twoWay(2, 2), slot(17.5, 1, 0, 180)] });
    net.addCorridor(seam(-560, y + 230, { x: 1, y: -0.25 }).id, s.id, { cls: 'highway', portB: 17.5, lanes: oneWay(1) });
  }

  // Автомагистраль с барьером: полоса торможения появляется заранее и уходит в съезд.
  y = 1300;
  title(-650, y - 90, 'Автомагистраль 2‖2: полоса торможения и съезд');
  {
    const s = seam(100, y);
    net.addCorridor(seam(-650, y).id, s.id, { cls: 'motorway', lanes: [...twoWay(2, 2, 4), slot(19.5, 1, 420)] });
    net.addCorridor(s.id, seam(750, y).id, { cls: 'motorway', lanes: twoWay(2, 2, 4) });
    net.addCorridor(s.id, seam(700, y + 260, { x: 1, y: 0.3 }).id, { cls: 'highway', portA: 19.5, lanes: oneWay(1) });
  }

  // Перекрёсток проспекта 2+2 и улицы 1+1.
  y = 2000;
  title(-650, y - 380, 'Перекрёсток проспекта и улицы');
  {
    const j = net.addJunction({ x: 0, y });
    const ends = [seam(-600, y), seam(600, y), seam(0, y - 330, { x: 0, y: 1 }), seam(0, y + 330, { x: 0, y: 1 })];
    net.addCorridor(ends[0].id, j.id, { cls: 'avenue', lanes: twoWay(2, 2) });
    net.addCorridor(j.id, ends[1].id, { cls: 'avenue', lanes: twoWay(2, 2) });
    net.addCorridor(ends[2].id, j.id, { cls: 'street', lanes: twoWay(1, 1) });
    net.addCorridor(j.id, ends[3].id, { cls: 'street', lanes: twoWay(1, 1) });
    // Перекрёсток без светофора пропускает меньше, чем магистраль: машин сюда — поменьше.
    for (const e of ends) sparse.set(e.id, 2.5);
  }

  // Односторонняя на две полосы делится на две по одной.
  y = 2650;
  title(-650, y - 220, 'Развилка односторонней');
  {
    const s = seam(0, y);
    net.addCorridor(seam(-600, y).id, s.id, { cls: 'avenue', lanes: oneWay(2) });
    net.addCorridor(s.id, seam(560, y - 180, { x: 1, y: -0.2 }).id, { cls: 'avenue', portA: -3.5, lanes: oneWay(1) });
    net.addCorridor(s.id, seam(560, y + 180, { x: 1, y: 0.2 }).id, { cls: 'avenue', portA: 3.5, lanes: oneWay(1) });
  }

  // Улица 1+1 расходится на два встречных полотна — начало дороги с островком посередине.
  y = 3250;
  title(-650, y - 120, 'Улица расходится на два встречных полотна');
  {
    const s = seam(0, y);
    net.addCorridor(seam(-600, y).id, s.id, { cls: 'avenue', lanes: twoWay(1, 1) });
    net.addCorridor(s.id, seam(600, y + 45).id, { cls: 'avenue', portA: 3.5, lanes: [slot(0, 1)] });
    net.addCorridor(s.id, seam(600, y - 45).id, { cls: 'avenue', portA: -3.5, lanes: [slot(0, -1)] });
  }

  // Изогнутая дорога с полосой для обгона посередине.
  y = 3900;
  title(-650, y - 200, 'Полоса для обгона на изгибе');
  {
    const dir = { x: 1, y: -0.5 };
    net.addCorridor(seam(-600, y, dir).id, seam(600, y, dir).id, { cls: 'avenue', lanes: [...twoWay(1, 1), slot(10.5, 1, 300, 700)] });
  }

  return { net, titles, sparse };
}
