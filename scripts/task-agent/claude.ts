/**
 * Запуск Claude Code без интерфейса (`claude -p`): задание — на stdin, ход работы — потоком stream-json
 * (коротко печатаем, полностью пишем в файл), итог — структурированный ответ по JSON-схеме.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface ClaudeSettings {
  /** Команда Claude Code. */
  bin: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  maxBudgetUsd?: string;
  /** Дополнительные аргументы claude. */
  extraArgs: string[];
  timeoutMs: number;
}

export interface ClaudeRequest {
  prompt: string;
  /** JSON-схема итогового ответа. */
  schema: object;
  appendSystemPrompt?: string;
  /** Новая сессия с этим id или продолжение прежней. */
  session: { id: string; resume: boolean };
  /** Имя сессии в списке /resume. */
  name?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Куда писать весь поток событий. */
  logFile?: string;
  log: (line: string) => void;
  signal?: AbortSignal;
}

export interface ClaudeResult {
  ok: boolean;
  sessionId?: string;
  output?: unknown;
  error?: string;
  costUsd?: number;
  /** Ходов модели; 0 — сессия даже не началась (например, продолжать нечего). */
  turns?: number;
  /** Claude недоступен вообще (нет входа, лимит, сбой API) — задача тут ни при чём. */
  outage?: string;
  durationMs: number;
}

/** Ошибка короткого запроса; outage — Claude недоступен вообще. */
export class ClaudeError extends Error {
  readonly outage?: string;
  constructor(message: string, outage?: string) {
    super(message);
    this.outage = outage;
  }
}

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  permissionMode?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: ContentBlock[] };
  /** Код ошибки API у сообщения-ошибки (is_api_error_message). */
  error?: string;
  is_api_error_message?: boolean;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  errors?: string[];
}

/** Ошибки API, при которых Claude не может работать ни над какой задачей. */
const OUTAGES: Record<string, string> = {
  authentication_failed: 'Claude Code не авторизован — войдите заново: claude auth login',
  billing_error: 'у аккаунта Claude проблема с оплатой',
  rate_limit: 'исчерпан лимит запросов Claude',
  server_error: 'API Claude не отвечает',
};

/** Причина недоступности Claude по коду ошибки API или, если кода нет, по тексту ошибки. */
export function outageOf(apiError: string | undefined, text = ''): string | undefined {
  if (apiError && OUTAGES[apiError]) return OUTAGES[apiError];
  if (/Failed to authenticate|Not logged in|Please run \/login|Invalid API key|OAuth (session|token)/i.test(text)) {
    return OUTAGES.authentication_failed;
  }
  if (/usage limit|limit reached/i.test(text)) return OUTAGES.rate_limit;
  return undefined;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export function runClaude(s: ClaudeSettings, r: ClaudeRequest): Promise<ClaudeResult> {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(r.schema)];
  args.push(...(r.session.resume ? ['--resume', r.session.id] : ['--session-id', r.session.id]));
  if (r.name) args.push('--name', r.name);
  if (r.appendSystemPrompt) args.push('--append-system-prompt', r.appendSystemPrompt);
  if (s.model) args.push('--model', s.model);
  if (s.effort) args.push('--effort', s.effort);
  if (s.permissionMode) args.push('--permission-mode', s.permissionMode);
  if (s.maxBudgetUsd) args.push('--max-budget-usd', s.maxBudgetUsd);
  args.push(...s.extraArgs);

  const started = Date.now();
  return new Promise((resolve) => {
    // Своя группа процессов: Ctrl+C в терминале достаётся только монитору, а он сам решает, когда остановить Claude.
    const child = spawn(s.bin, args, { cwd: r.cwd, env: r.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const raw = r.logFile ? createWriteStream(r.logFile, { flags: 'a' }) : undefined;
    let sessionId: string | undefined;
    let final: StreamEvent | undefined;
    let apiError: string | undefined;
    let spawnError: string | undefined;
    const stderr: string[] = [];
    let killed: string | undefined;

    // Сигнал всей группе: вместе с Claude останавливаются и запущенные им команды (тесты, dev-сервер).
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const stop = (why: string) => {
      if (killed || child.exitCode !== null) return;
      killed = why;
      signalGroup('SIGTERM');
      setTimeout(() => child.exitCode === null && signalGroup('SIGKILL'), 10_000).unref();
    };
    const timer = setTimeout(() => stop(`превышено время работы (${Math.round(s.timeoutMs / 60_000)} мин)`), s.timeoutMs);
    const onAbort = () => stop('остановлено');
    r.signal?.addEventListener('abort', onAbort, { once: true });
    const onExit = () => signalGroup('SIGKILL');
    process.on('exit', onExit);

    createInterface({ input: child.stdout }).on('line', (line) => {
      raw?.write(`${line}\n`);
      let e: StreamEvent;
      try {
        e = JSON.parse(line) as StreamEvent;
      } catch {
        return;
      }
      if (e.session_id) sessionId = e.session_id;
      if (e.is_api_error_message) apiError = e.error;
      if (e.type === 'system' && e.subtype === 'init') r.log(`Claude: ${e.model}, права: ${e.permissionMode}, сессия ${e.session_id}`);
      else if (e.type === 'assistant' && !e.parent_tool_use_id) for (const b of e.message?.content ?? []) logBlock(b, r.log);
      else if (e.type === 'result') final = e;
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      raw?.write(`# stderr: ${line}\n`);
      stderr.push(line);
      if (stderr.length > 20) stderr.shift();
    });

    child.stdin.on('error', () => {});
    child.stdin.end(r.prompt);
    child.on('error', (err) => {
      spawnError = `не запускается ${s.bin}: ${err.message}`;
      stderr.push(String(err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      r.signal?.removeEventListener('abort', onAbort);
      process.off('exit', onExit);
      raw?.end();
      const base = { sessionId, costUsd: final?.total_cost_usd, turns: final?.num_turns, durationMs: Date.now() - started };
      if (final && !final.is_error && final.structured_output !== undefined) {
        resolve({ ...base, ok: true, output: final.structured_output });
        return;
      }
      const err = stderr.join('\n').trim();
      const reason =
        killed ??
        (final && !final.is_error && final.subtype === 'success'
          ? 'нет структурированного ответа'
          : final?.errors?.join('; ') || final?.result || err || final?.subtype || `claude завершился с кодом ${code}`);
      const outage = killed ? undefined : (spawnError ?? outageOf(apiError, reason));
      resolve({ ...base, ok: false, error: reason, outage });
    });
  });
}

/** Короткая строка о шаге Claude: текст — первой строкой, инструмент — с главным параметром. */
function logBlock(b: ContentBlock, log: (line: string) => void): void {
  if (b.type === 'text' && b.text?.trim()) {
    log(`  » ${clip(b.text.trim().split('\n')[0], 160)}`);
  } else if (b.type === 'tool_use' && b.name && b.name !== 'StructuredOutput') {
    const i = b.input ?? {};
    const detail = i.description ?? i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.prompt ?? '';
    log(`  › ${b.name}${detail ? `: ${clip(String(detail).split('\n')[0], 140)}` : ''}`);
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Короткий ответ без инструментов и без сохранения сессии (например, название задачи). */
export async function askClaude<T>(bin: string, model: string, prompt: string, schema: object, env: NodeJS.ProcessEnv): Promise<T> {
  const res = await ask(bin, model, prompt, schema, env);
  if (res.structured_output === undefined) throw new ClaudeError('нет структурированного ответа');
  return res.structured_output as T;
}

/** Отвечает ли Claude вообще: undefined — да, иначе причина. Проверяется той моделью, что будет работать над задачами. */
export async function checkClaude(bin: string, model: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    await ask(bin, model, 'Ответь одним словом: ok', undefined, env);
    return undefined;
  } catch (e) {
    return e instanceof ClaudeError ? (e.outage ?? e.message) : String(e);
  }
}

/** Запрос без инструментов, MCP-серверов и сохранения сессии; ошибка — ClaudeError с причиной недоступности, если она такая. */
function ask(bin: string, model: string, prompt: string, schema: object | undefined, env: NodeJS.ProcessEnv): Promise<StreamEvent> {
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config'];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (model) args.push('--model', model);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', (e) => {
      const why = `не запускается ${bin}: ${e.message}`;
      reject(new ClaudeError(why, why));
    });
    child.on('close', () => {
      clearTimeout(timer);
      let res: StreamEvent | undefined;
      let apiError: string | undefined;
      try {
        // Один итог или, с verbose в настройках Claude Code, список всех событий — итог в конце.
        const data = JSON.parse(out) as StreamEvent | StreamEvent[];
        const events = Array.isArray(data) ? data : [data];
        res = events.filter((e) => e.type === 'result').pop();
        apiError = events.filter((e) => e.is_api_error_message).pop()?.error;
      } catch {
        // не JSON — ниже ошибка с началом вывода
      }
      if (res && !res.is_error) {
        resolve(res);
        return;
      }
      const text = res?.result || out.trim().slice(0, 300) || 'нет ответа';
      reject(new ClaudeError(text, outageOf(apiError, text)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
