/**
 * Агент доски задач: следит за доской и отдаёт задачи Claude Code.
 *
 *   npm run agent                 — следить за доской, пока не остановят (Ctrl+C)
 *   npm run agent -- --once       — разобрать текущую очередь и выйти
 *   npm run agent -- --dry-run    — показать очередь, ничего не меняя
 *   npm run agent -- --task <id>  — брать только эту задачу
 *
 * Задачи «Новая» и «Доработать» (сначала доработки) по одной переводятся в «В работе» и отдаются Claude Code
 * в этом репозитории. Его отчёт со скриншотами и файлом сохранения уходит комментарием, а задача —
 * в «Нужно проверить». Настройки — переменные окружения или .env (образец — .env.example),
 * подробности — docs/TASK_AGENT.md.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, BoardError, MAX_FILE_BYTES, STATUS_NAMES, type Task, type TaskStatus } from './board';
import { askClaude, runClaude, type ClaudeResult, type ClaudeSettings } from './claude';
import {
  REPORT_SCHEMA,
  SYSTEM_PROMPT,
  TITLE_SCHEMA,
  taskPrompt,
  titlePrompt,
  type AgentReport,
  type Attachment,
  type CommentView,
  type InputFile,
} from './prompt';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** Префикс sourceKey комментариев агента — по нему агент узнаёт свои отчёты. */
const SOURCE = 'task-agent';
const QUEUE: TaskStatus[] = ['revision', 'todo'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const SAVE_EXT = ['.json'];

// ---------- Настройки ----------

interface Config {
  base: string;
  board: string;
  token: string;
  actor: string;
  pollMs: number;
  commit: boolean;
  resume: boolean;
  maxAttempts: number;
  retryMs: number;
  titleModel: string;
  /** Состояние, задания и журналы запусков. */
  stateDir: string;
  claude: ClaudeSettings;
}

function loadConfig(): Config {
  const file = join(ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
  const env = (name: string) => process.env[name]?.trim() || undefined;
  const num = (name: string, def: number) => {
    const v = Number(env(name) ?? def);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  const bool = (name: string, def: boolean) => {
    const v = env(name)?.toLowerCase();
    return v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(v);
  };
  const missing = ['TASKS_BASE_URL', 'TASKS_BOARD', 'TASKS_TOKEN'].filter((k) => !env(k));
  if (missing.length) {
    console.error(`Не заданы ${missing.join(', ')} — допишите их в .env (образец — .env.example).`);
    process.exit(1);
  }
  return {
    base: env('TASKS_BASE_URL')!.replace(/\/+$/, ''),
    board: env('TASKS_BOARD')!,
    token: env('TASKS_TOKEN')!,
    actor: env('TASK_AGENT_ACTOR') ?? 'Claude Code',
    pollMs: num('TASK_AGENT_POLL_SECONDS', 60) * 1000,
    commit: bool('TASK_AGENT_COMMIT', false),
    resume: bool('TASK_AGENT_RESUME', true),
    maxAttempts: num('TASK_AGENT_MAX_ATTEMPTS', 2),
    retryMs: num('TASK_AGENT_RETRY_MINUTES', 15) * 60_000,
    titleModel: env('TASK_AGENT_TITLE_MODEL') ?? 'haiku',
    stateDir: resolve(ROOT, env('TASK_AGENT_STATE_DIR') ?? '.task-agent'),
    claude: {
      bin: env('TASK_AGENT_CLAUDE_BIN') ?? 'claude',
      model: env('TASK_AGENT_MODEL'),
      effort: env('TASK_AGENT_EFFORT'),
      permissionMode: env('TASK_AGENT_PERMISSION_MODE') ?? 'auto',
      maxBudgetUsd: env('TASK_AGENT_MAX_BUDGET_USD'),
      extraArgs: env('TASK_AGENT_CLAUDE_ARGS')?.split(/\s+/) ?? [],
      timeoutMs: num('TASK_AGENT_TIMEOUT_MINUTES', 120) * 60_000,
    },
  };
}

// ---------- Состояние между запусками ----------

interface State {
  /** Сессия Claude по задаче: на доработке продолжаем её же. */
  sessions: Record<string, string>;
  /** Неудачи подряд по задаче и когда пробовать снова. */
  failures: Record<string, { count: number; retryAt: number }>;
  /** Задача в работе: если монитор прервали, при запуске она вернётся в очередь. */
  active?: { taskId: string; from: TaskStatus };
  /** Готовые отчёты, которые ещё не удалось опубликовать (например, не было сети). */
  pending: Record<string, Delivery>;
}

interface Delivery {
  taskId: string;
  runId: string;
  outDir: string;
  report: AgentReport;
  durationMs: number;
  costUsd?: number;
}

function readState(): State {
  const empty: State = { sessions: {}, failures: {}, pending: {} };
  try {
    return { ...empty, ...(JSON.parse(readFileSync(join(cfg.stateDir, 'state.json'), 'utf8')) as Partial<State>) };
  } catch {
    return empty;
  }
}

function saveState(): void {
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(join(cfg.stateDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

// ---------- Запуск ----------

const args = process.argv.slice(2);
const once = args.includes('--once');
const dryRun = args.includes('--dry-run');
const only = args.includes('--task') ? args[args.indexOf('--task') + 1] : undefined;

const cfg = loadConfig();
const board = new Board(cfg.base, cfg.board, cfg.token);
const state = readState();
/** Прервать работу Claude сейчас. */
const abort = new AbortController();
/** Разбудить монитор из ожидания. */
let wake = () => {};
let stopping = false;
let busy = false;

let lastSigint = 0;
process.on('SIGINT', () => {
  // Под npm run один Ctrl+C приходит дважды: от терминала и пересланный npm — это одно нажатие.
  const now = Date.now();
  if (now - lastSigint < 1000) return;
  lastSigint = now;
  if (busy && !stopping) {
    stopping = true;
    log('Остановлюсь после текущей задачи. Ctrl+C ещё раз — прервать её сейчас (задача вернётся в очередь).');
  } else {
    stopping = true;
    abort.abort();
  }
  wake();
});
process.on('SIGTERM', () => {
  stopping = true;
  abort.abort();
  wake();
});

void main().catch((e) => {
  log(`Ошибка: ${message(e)}`);
  process.exit(1);
});

async function main(): Promise<void> {
  log(`Доска «${cfg.board}» (${cfg.base}), исполнитель «${cfg.actor}»${dryRun ? ', без изменений' : ''}`);
  if (dryRun) {
    const queue = await nextTasks();
    log(queue.length ? `В очереди ${queue.length}:` : 'Очередь пуста.');
    for (const t of queue) log(`  ${STATUS_NAMES[t.status]} · ${t.title?.trim() || '(без названия)'} · ${t.id}`);
    return;
  }
  await recover();
  while (!stopping) {
    let worked = false;
    try {
      await deliverPending();
      const [task] = await nextTasks();
      if (task) {
        busy = true;
        await work(task);
        worked = true;
      }
    } catch (e) {
      log(`Ошибка: ${message(e)}`);
    } finally {
      busy = false;
    }
    if (stopping || (once && !worked)) break;
    if (!worked) await sleep(cfg.pollMs);
  }
  log('Монитор остановлен.');
}

/** Задачи, которые пора брать: сначала доработки, потом новые; внутри — старые раньше. */
async function nextTasks(): Promise<Task[]> {
  const now = Date.now();
  const rank = (t: Task) => QUEUE.indexOf(t.status);
  const time = (t: Task) => Date.parse(t.createdAt ?? '') || 0;
  return (await board.tasks())
    .filter((t) => QUEUE.includes(t.status) && (!only || t.id === only))
    .filter((t) => (state.failures[t.id]?.retryAt ?? 0) <= now)
    .sort((a, b) => rank(a) - rank(b) || time(a) - time(b));
}

/** После прерванного запуска: готовый отчёт — опубликовать, незаконченную задачу — вернуть в очередь. */
async function recover(): Promise<void> {
  const active = state.active;
  if (!active) return;
  if (!state.pending[active.taskId]) {
    const back = await patch(active.taskId, (c) => (c.status === 'in_progress' ? { status: active.from } : null)).catch(() => null);
    if (back) log(`Прошлый запуск прервался: задача ${active.taskId} возвращена в «${STATUS_NAMES[active.from]}».`);
  }
  state.active = undefined;
  saveState();
}

// ---------- Работа над задачей ----------

async function work(brief: Task): Promise<void> {
  const from = brief.status;
  let card = await board.task(brief.id);
  const description = await descriptionOf(card);
  const title = card.title?.trim() || (await makeTitle(description));
  const taken = await patch(card.id, (c) =>
    QUEUE.includes(c.status) ? { status: 'in_progress', ...(c.title?.trim() ? {} : { title }) } : null,
  );
  if (!taken) {
    log(`Задачу «${title}» уже кто-то взял или убрал из очереди — пропускаю.`);
    return;
  }
  state.active = { taskId: card.id, from };
  saveState();
  log(`▶ «${title}»: ${STATUS_NAMES[from]} → ${STATUS_NAMES.in_progress}`);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(cfg.stateDir, 'runs', card.id, runId);
  const outDir = join(runDir, 'out');
  let result: ClaudeResult;
  try {
    card = await board.task(card.id);
    mkdirSync(outDir, { recursive: true });
    const comments = await commentsOf(card);
    const inputs = await downloadInputs(description, comments, join(runDir, 'input'));
    const prompt = taskPrompt({
      task: card,
      title,
      from,
      description,
      comments,
      inputs,
      outDir: shown(outDir),
      commit: cfg.commit,
    });
    writeFileSync(join(runDir, 'prompt.md'), prompt);
    log(`Задание и журнал Claude: ${shown(runDir)}`);
    result = await runAgent(card.id, title, prompt, runDir);
  } catch (e) {
    result = { ok: false, error: message(e), durationMs: 0 };
  }
  log(`Claude: ${result.ok ? 'готово' : `не справился — ${result.error}`} (${minutes(result.durationMs)}${cost(result.costUsd)})`);

  if (abort.signal.aborted) {
    await patch(card.id, (c) => (c.status === 'in_progress' ? { status: from } : null)).catch(() => null);
    state.active = undefined;
    saveState();
    log(`Прервано: задача возвращена в «${STATUS_NAMES[from]}».`);
    return;
  }
  if (!result.ok) {
    await failed(card.id, from, result.error ?? 'неизвестная ошибка', runId);
    return;
  }
  state.pending[card.id] = {
    taskId: card.id,
    runId,
    outDir,
    report: result.output as AgentReport,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
  };
  delete state.failures[card.id];
  saveState();
  await deliver(state.pending[card.id]);
}

/** Запуск Claude; на доработке — в прежней сессии, если она ещё есть. */
async function runAgent(taskId: string, title: string, prompt: string, runDir: string): Promise<ClaudeResult> {
  const run = (id: string, resume: boolean) => {
    state.sessions[taskId] = id;
    saveState();
    return runClaude(cfg.claude, {
      prompt,
      schema: REPORT_SCHEMA,
      appendSystemPrompt: SYSTEM_PROMPT,
      session: { id, resume },
      name: `Задача: ${title}`,
      cwd: ROOT,
      env: childEnv(),
      logFile: join(runDir, 'claude.jsonl'),
      log,
      signal: abort.signal,
    });
  };
  const previous = cfg.resume ? state.sessions[taskId] : undefined;
  if (previous) {
    log(`Продолжаю сессию ${previous}`);
    const r = await run(previous, true);
    // Сессия не открылась (удалена, другая машина) — начинаем новую.
    if (r.ok || r.turns !== 0 || abort.signal.aborted) return r;
    log(`Прежнюю сессию не продолжить (${r.error}) — начинаю новую.`);
  }
  return run(randomUUID(), false);
}

/** Claude не справился: вернуть задачу в очередь до следующей попытки, а после последней — отчитаться. */
async function failed(taskId: string, from: TaskStatus, error: string, runId: string): Promise<void> {
  const count = (state.failures[taskId]?.count ?? 0) + 1;
  if (count >= cfg.maxAttempts) {
    const text = `**Не получилось выполнить задачу автоматически.**\n\nПопыток: ${count}. Последняя ошибка: ${error}`;
    await postComment(taskId, redact(text), `${SOURCE}:${taskId}:error:${runId}`);
    await patch(taskId, (c) => (c.status === 'in_progress' ? { status: 'review' } : null));
    delete state.failures[taskId];
    log(`Задача → «${STATUS_NAMES.review}» с описанием ошибки.`);
  } else {
    state.failures[taskId] = { count, retryAt: Date.now() + cfg.retryMs };
    await patch(taskId, (c) => (c.status === 'in_progress' ? { status: from } : null));
    log(`Задача возвращена в «${STATUS_NAMES[from]}», новая попытка через ${minutes(cfg.retryMs)}.`);
  }
  state.active = undefined;
  saveState();
}

/** Отчёты, которые не опубликовались раньше. Задачу удалили — отчёт больше некуда публиковать. */
async function deliverPending(): Promise<void> {
  for (const d of Object.values(state.pending)) {
    try {
      await deliver(d);
    } catch (e) {
      log(`Отчёт по задаче ${d.taskId} пока не опубликован: ${message(e)}`);
      if (e instanceof BoardError && (e.status === 404 || e.status === 410)) {
        delete state.pending[d.taskId];
        saveState();
      }
    }
  }
}

/** Публикует отчёт: файлы — в загрузчик, текст — комментарием, задачу — в «Нужно проверить». */
async function deliver(d: Delivery): Promise<void> {
  const skipped: string[] = [];
  const shots = pickFiles(d.report.screenshots, d.outDir, IMAGE_EXT, skipped);
  const saves = pickFiles(d.report.saves, d.outDir, SAVE_EXT, skipped);
  const files = [...shots, ...saves];
  const uploaded = await board.upload(files.map((f) => ({ name: f.name, data: readFileSync(f.path) })));
  const url = (i: number) => uploaded[i].url;

  const parts: string[] = [];
  if (d.report.outcome === 'needs_info') parts.push('**Нужны уточнения**');
  if (d.report.outcome === 'failed') parts.push('**Не получилось сделать**');
  parts.push(d.report.summary.trim());
  if (shots.length) parts.push(shots.map((s, i) => `${s.caption}\n\n![Скриншот ${i + 1}](<${url(i)}>)`).join('\n\n'));
  if (saves.length) {
    const list = saves.map((s, i) => `- [${s.name}](<${url(shots.length + i)}>) — ${s.caption}`);
    parts.push(['**Сохранение для проверки** (Меню → Сохранения → «Открыть из файла»):', ...list].join('\n'));
  }
  if (skipped.length) parts.push(`Не приложено: ${skipped.join('; ')}`);
  parts.push(`_${cfg.actor} · ${minutes(d.durationMs)}${cost(d.costUsd)}_`);
  await postComment(d.taskId, redact(parts.join('\n\n')), `${SOURCE}:${d.taskId}:result:${d.runId}`);

  const moved = await patch(d.taskId, (c) => (c.status === 'in_progress' ? { status: 'review' } : null)).catch((e) => {
    if (e instanceof BoardError && (e.status === 404 || e.status === 410)) return null;
    throw e;
  });
  delete state.pending[d.taskId];
  if (state.active?.taskId === d.taskId) state.active = undefined;
  saveState();
  log(
    moved
      ? `✓ Отчёт опубликован (снимков ${shots.length}, сохранений ${saves.length}), задача → «${STATUS_NAMES.review}».`
      : '✓ Отчёт опубликован; статус задачи за это время поменяли — оставляю его как есть.',
  );
}

// ---------- Карточка ----------

async function descriptionOf(card: Task): Promise<string> {
  if (typeof card.description === 'string') return card.description;
  if (!card.descriptionDocumentId) return '';
  return (await board.document(card.descriptionDocumentId)).text;
}

async function commentsOf(card: Task): Promise<CommentView[]> {
  const out: CommentView[] = [];
  for (const c of card.comments ?? []) {
    const body = c.body ?? (c.documentId ? (await board.document(c.documentId)).text : '');
    out.push({
      author: c.author ?? 'Без имени',
      date: c.createdAt ? new Date(c.createdAt).toLocaleString('ru-RU') : undefined,
      body,
      mine: !!c.sourceKey?.startsWith(`${SOURCE}:`),
    });
  }
  return out;
}

/** Название для задачи без него — по сути описания (как просит доска), а не первой строкой. */
async function makeTitle(description: string): Promise<string> {
  const fallback = description.trim().split('\n')[0]?.replace(/[#*_`>[\]]/g, '').trim().slice(0, 80) || 'Задача без описания';
  if (!description.trim()) return fallback;
  try {
    const { title } = await askClaude<{ title: string }>(cfg.claude.bin, cfg.titleModel, titlePrompt(description), TITLE_SCHEMA, childEnv());
    return title.trim() || fallback;
  } catch (e) {
    log(`Название не придумалось (${message(e)}) — беру первую строку описания.`);
    return fallback;
  }
}

/** Изменение карточки с актуальной revision; при конфликте перечитываем и решаем заново (null — не менять). */
async function patch(taskId: string, change: (c: Task) => { status?: TaskStatus; title?: string } | null): Promise<Task | null> {
  let card = await board.task(taskId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const body = change(card);
    if (!body) return null;
    try {
      await board.patchTask(taskId, { revision: card.revision, actor: cfg.actor, ...body });
      return card;
    } catch (e) {
      if (!(e instanceof BoardError && e.status === 409)) throw e;
      card = await board.task(taskId);
    }
  }
  throw new Error(`Карточку ${taskId} всё время меняют — не удалось обновить`);
}

/** Комментарий с текстом. sourceKey устойчивый: повтор после сбоя не создаёт второй отчёт. */
async function postComment(taskId: string, text: string, sourceKey: string): Promise<void> {
  let card = await board.task(taskId);
  let comment = card.comments?.find((c) => c.sourceKey === sourceKey);
  for (let attempt = 0; !comment && attempt < 5; attempt++) {
    try {
      card = await board.addComment(taskId, { author: cfg.actor, revision: card.revision, sourceKey });
    } catch (e) {
      if (!(e instanceof BoardError && e.status === 409)) throw e;
      card = await board.task(taskId);
    }
    comment = card.comments?.find((c) => c.sourceKey === sourceKey);
  }
  if (!comment) throw new Error('Не удалось создать комментарий');
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc = await board.document(comment.documentId);
    if (doc.text.includes(text.trim())) return;
    // В новый комментарий кто-то успел написать — свой текст ставим после чужого, не затирая его.
    const next = doc.text.trim() ? `${doc.text.trimEnd()}\n\n${text}` : text;
    try {
      const saved = await board.writeDocument(comment.documentId, next, doc.hash);
      if (saved.saved === false) log('Комментарий записан, но сервер ещё не подтвердил сохранение.');
      return;
    } catch (e) {
      if (!(e instanceof BoardError && e.status === 409)) throw e;
    }
  }
  throw new Error('Не удалось записать текст комментария');
}

// ---------- Файлы ----------

/** Картинки и файлы доски из описания и комментариев — в папку запуска, чтобы Claude мог их открыть. */
async function downloadInputs(description: string, comments: CommentView[], dir: string): Promise<InputFile[]> {
  const sources = [{ where: 'описание', text: description }, ...comments.map((c, i) => ({ where: `комментарий ${i + 1}`, text: c.body }))];
  const seen = new Set<string>();
  const out: InputFile[] = [];
  for (const { where, text } of sources) {
    for (const url of text.match(/https?:\/\/[^\s<>()"'\]]+/g) ?? []) {
      if (seen.has(url) || !board.isOwnFile(url)) continue;
      seen.add(url);
      try {
        const data = await board.download(url);
        const name = decodeURIComponent(basename(new URL(url).pathname)).replace(/[^\p{L}\p{N}._-]+/gu, '_');
        const file = join(dir, `${String(out.length + 1).padStart(2, '0')}-${name}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, data);
        out.push({ file: shown(file), where });
      } catch (e) {
        log(`Не скачалось вложение ${url}: ${message(e)}`);
      }
    }
  }
  return out;
}

interface Picked {
  path: string;
  name: string;
  caption: string;
}

/** Вложения отчёта: только существующие файлы нужного типа из папки вложений этого запуска. */
function pickFiles(list: Attachment[], outDir: string, exts: string[], skipped: string[]): Picked[] {
  const root = realpathSync(outDir);
  const out: Picked[] = [];
  for (const a of list ?? []) {
    const candidates = isAbsolute(a.file) ? [a.file] : [resolve(ROOT, a.file), resolve(outDir, a.file)];
    const found = candidates.find((p) => existsSync(p) && statSync(p).isFile());
    const name = basename(a.file);
    if (!found) {
      skipped.push(`${name} — нет файла`);
      continue;
    }
    const path = realpathSync(found);
    const rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel)) skipped.push(`${name} — не из папки вложений`);
    else if (!exts.includes(extname(path).toLowerCase())) skipped.push(`${name} — не ${exts.join('/')}`);
    else if (statSync(path).size > MAX_FILE_BYTES) skipped.push(`${name} — больше 20 МБ`);
    else out.push({ path, name: basename(path), caption: a.caption.trim() || basename(path) });
  }
  return out;
}

// ---------- Мелочи ----------

/** Окружение Claude — без токена доски: доской управляет только монитор. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TASKS_TOKEN;
  return env;
}

/** Токен доски не должен попасть в комментарий, даже если Claude его где-то увидел. */
function redact(text: string): string {
  return text.split(cfg.token).join('***');
}

/** Путь для задания и журнала: от корня репозитория, а вне его — полностью. */
function shown(path: string): string {
  const rel = relative(ROOT, path);
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}

function minutes(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} с` : `${Math.round(ms / 60_000)} мин`;
}

function cost(usd?: number): string {
  return usd ? ` · $${usd.toFixed(2)}` : '';
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function log(line: string): void {
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] ${line}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    wake = () => {
      clearTimeout(timer);
      done();
    };
  });
}
