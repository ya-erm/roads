/**
 * Снимок игры для отчётов агента доски (и для ручной проверки): headless Chromium открывает игру — при
 * необходимости партию из файла сохранения, — ждёт, снимает экран и может выгрузить партию в файл.
 *
 *   npm run shot -- --out shot.png [параметры]      — npm run shot -- --help: все параметры
 *
 * Берёт запущенный dev-сервер игры (TASK_AGENT_GAME_URL, по умолчанию http://localhost:4800), иначе поднимает свой.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Browser } from 'playwright';
import { createServer } from 'vite';
import { areaArg, fitCamera, parseArea, type WorldBox } from '../../src/bugreport/spot';

const HELP = `npm run shot -- [параметры]

  --out <файл.png>        снимок экрана
  --url <путь>            страница игры (по умолчанию /): /test/bus, "/?seed=42", "/?scenario=easy&seed=7"
  --save <файл.json>      открыть партию через «Меню → Загрузить → Открыть из файла»
  --speed <n>             скорость игры после загрузки: 0 — пауза, 1, 2, 4…
  --camera <x,y,zoom>     поставить камеру (координаты мира)
  --area <x0,y0,x1,y1>    камера — на участок мира, участок — в синей рамке (как «Где на карте» в баг-репорте)
  --click <css>           нажать на элемент интерфейса (можно несколько раз, по порядку)
  --eval <js>             выполнить код на странице (есть window.game, camera, controller); return — напечатать
  --wait <мс>             подождать перед снимком (по умолчанию 1500)
  --export-save <файл>    после ожидания сохранить партию в файл — как «Сохранить в файл»
  --size <ШxВ>            размер окна (по умолчанию 1440x900)
  --scale <n>             плотность пикселей (по умолчанию 1)
  --start-screen          не закрывать стартовое окно («Дороги региона», брифинг сценария)

Стартовое окно новой партии закрывается само (игра остаётся на паузе): под его размытым фоном headless-браузер
не обновляет карту, и построенное через --eval на снимке не видно.
Сохранение из баг-репорта само открывается с участком в рамке; --area из строки «Где на карте» ставит на него камеру.
Сохранения пишутся в отдельный слот (?slot=task-agent-shot) и партию пользователя не трогают.`;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const { values: opt } = parseArgs({
  options: {
    out: { type: 'string' },
    url: { type: 'string', default: '/' },
    save: { type: 'string' },
    speed: { type: 'string' },
    camera: { type: 'string' },
    area: { type: 'string' },
    click: { type: 'string', multiple: true },
    eval: { type: 'string' },
    wait: { type: 'string', default: '1500' },
    'export-save': { type: 'string' },
    size: { type: 'string', default: '1440x900' },
    scale: { type: 'string', default: '1' },
    'start-screen': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (opt.help || !(opt.out || opt['export-save'] || opt.eval)) {
  console.log(HELP);
  process.exit(opt.help ? 0 : 1);
}

/** Что игра выставляет в window для отладки (src/main.ts). */
interface GameWindow {
  game: { speed: number; toSave(): { view?: { x: number; y: number; zoom: number } } };
  camera: { x: number; y: number; zoom: number; width: number; height: number; minZoom: number; maxZoom: number; touched: boolean };
  /** Рамка участка из баг-репорта (src/ui/bugSpotFrame.ts). */
  bugSpot?: { show(area: WorldBox | null): void; readonly shown: WorldBox | null };
  __shotBefore?: unknown;
}

const area = opt.area ? parseArea(opt.area) : null;
if (opt.area && !area) {
  console.error(`--area ${opt.area}: нужно x0,y0,x1,y1 — числа, углы участка в мире`);
  process.exit(1);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

async function main(): Promise<void> {
  if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
  const [width, height] = opt.size.split('x').map(Number);
  const server = await gameServer();
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: Number(opt.scale) || 1 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text())));

    const url = new URL(opt.url, server.url);
    if (!url.searchParams.has('slot')) url.searchParams.set('slot', 'task-agent-shot');
    await page.goto(url.href);
    await page.waitForFunction(() => 'game' in window, null, { timeout: 30_000 });
    // Стартовое окно — прочь, как кнопкой, но без запуска времени: под его размытым фоном карта на снимке не обновляется.
    if (!opt['start-screen']) await page.evaluate(() => document.querySelector('[data-start]')?.classList.add('hidden'));

    if (opt.save) {
      await page.evaluate(() => {
        const w = window as unknown as GameWindow;
        w.__shotBefore = w.game;
      });
      await page.setInputFiles('[data-import-save]', resolve(opt.save));
      const opened = await page
        .waitForFunction(() => (window as unknown as GameWindow).game !== (window as unknown as GameWindow).__shotBefore, null, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (!opened) throw new Error(`Сохранение ${opt.save} не открылось: не файл сохранения или другая версия игры (SAVE_VERSION).`);
      const marked = await page.evaluate(() => (window as unknown as GameWindow).bugSpot?.shown ?? null);
      if (marked && !area) console.log(`В сохранении участок из баг-репорта (в рамке): --area ${areaArg(marked)}`);
    }
    if (area) {
      // Тот же расчёт, что у рамки в игре (src/bugreport/spot.ts), — по размеру холста карты на странице.
      const c = await page.evaluate(() => {
        const { width, height, minZoom, maxZoom } = (window as unknown as GameWindow).camera;
        return { width, height, minZoom, maxZoom };
      });
      const cam = fitCamera(area, c.width, c.height, { minZoom: c.minZoom, maxZoom: c.maxZoom });
      await page.evaluate(
        ({ area, cam }) => {
          const w = window as unknown as GameWindow;
          Object.assign(w.camera, cam, { touched: true });
          w.bugSpot?.show(area);
        },
        { area, cam },
      );
    }
    if (opt.speed !== undefined) {
      await page.evaluate((v) => void ((window as unknown as GameWindow).game.speed = v), Number(opt.speed));
    }
    if (opt.camera) {
      const [x, y, zoom] = opt.camera.split(',').map(Number);
      await page.evaluate(
        ([x, y, zoom]) => {
          const c = (window as unknown as GameWindow).camera;
          Object.assign(c, { x, y, zoom, touched: true });
        },
        [x, y, zoom],
      );
    }
    for (const sel of opt.click ?? []) await page.click(sel, { timeout: 5000 });
    if (opt.eval) {
      const value: unknown = await page.evaluate(`(async () => { ${opt.eval}\n})()`);
      if (value !== undefined) console.log(`eval: ${JSON.stringify(value, null, 2)}`);
    }
    await page.waitForTimeout(Number(opt.wait) || 0);

    if (opt.out) {
      const out = resolve(opt.out);
      mkdirSync(dirname(out), { recursive: true });
      await page.screenshot({ path: out });
      console.log(`Снимок: ${opt.out}`);
    }
    if (opt['export-save']) {
      const json = await page.evaluate(() => {
        const { game, camera } = window as unknown as GameWindow;
        const data = game.toSave();
        data.view = { x: camera.x, y: camera.y, zoom: camera.zoom };
        return JSON.stringify(data);
      });
      const file = resolve(opt['export-save']);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, json);
      console.log(`Сохранение: ${opt['export-save']} (${Math.round(json.length / 1024)} КБ)`);
    }
    console.log(errors.length ? `Ошибки на странице:\n${errors.map((e) => `  ${e}`).join('\n')}` : 'Ошибок на странице нет.');
  } finally {
    await browser.close();
    await server.close();
  }
}

/** Запущенный dev-сервер игры или свой на время снимка. */
async function gameServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const url = process.env.TASK_AGENT_GAME_URL?.trim() || 'http://localhost:4800';
  if (await isGame(url)) return { url, close: async () => {} };
  const server = await createServer({
    root: ROOT,
    configFile: join(ROOT, 'vite.config.ts'),
    server: { port: 4810, strictPort: false },
    logLevel: 'error',
    clearScreen: false,
  });
  await server.listen();
  const local = server.resolvedUrls?.local[0];
  if (!local) throw new Error('Не удалось поднять dev-сервер игры');
  return { url: local, close: () => server.close() };
}

async function isGame(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok && (await res.text()).includes('id="game"');
  } catch {
    return false;
  }
}

/** Chromium из Playwright, а если его нет — установленный Chrome (TASK_AGENT_BROWSER_CHANNEL — выбрать явно). */
async function launch(): Promise<Browser> {
  const channel = process.env.TASK_AGENT_BROWSER_CHANNEL?.trim();
  try {
    return await chromium.launch(channel ? { channel } : {});
  } catch (e) {
    if (channel) throw e;
    return chromium.launch({ channel: 'chrome' }).catch(() => {
      throw new Error(`Не запускается браузер: ${e instanceof Error ? e.message.split('\n')[0] : e}\nУстановите его: npx playwright install chromium`);
    });
  }
}
