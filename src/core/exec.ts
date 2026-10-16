import { spawn, spawnSync } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  maxOutput?: number;
  input?: string;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

/** Run a shell command, capturing combined stdout/stderr. Never throws. */
export function runShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const max = opts.maxOutput ?? 512 * 1024;
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let cancelled = false;
    let done = false;
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI ?? '', ...opts.env },
      // Own process group on POSIX so a timeout can kill the whole tree.
      detached: process.platform !== 'win32',
    });
    const append = (d: Buffer) => {
      if (output.length < max) output += d.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();

    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (output.length >= max) output += '\n… output truncated …';
      resolve({ code, output: stripAnsi(output), timedOut, cancelled, durationMs: Date.now() - started });
    };
    child.on('error', (err) => {
      output += String(err);
      finish(127);
    });
    child.on('close', (code) => finish(code));
  });
}

/** Quote a single argument for the current platform's shell. */
export function shellQuote(arg: string): string {
  if (process.platform === 'win32') {
    return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
  }
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
