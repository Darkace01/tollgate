import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizePath } from './glob';

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export function git(args: string[], cwd: string, input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
        resolve({ code, stdout: stdout as Buffer, stderr: (stderr as Buffer)?.toString('utf8') ?? String(err ?? '') });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function gitText(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.toString('utf8');
}

export async function findRepoRoot(cwd: string): Promise<string | undefined> {
  const r = await git(['rev-parse', '--show-toplevel'], cwd);
  return r.code === 0 ? path.resolve(r.stdout.toString('utf8').trim()) : undefined;
}

/** Absolute path to the shared .git dir (handles worktrees). */
export async function gitCommonDir(root: string): Promise<string> {
  const out = (await gitText(['rev-parse', '--git-common-dir'], root)).trim();
  return path.resolve(root, out);
}

export async function hooksDir(root: string): Promise<string> {
  const out = (await gitText(['rev-parse', '--git-path', 'hooks'], root)).trim();
  return path.resolve(root, out);
}

export async function getConfigValue(root: string, key: string): Promise<string | undefined> {
  const r = await git(['config', '--get', key], root);
  return r.code === 0 ? r.stdout.toString('utf8').trim() : undefined;
}

export async function currentBranch(root: string): Promise<string> {
  const r = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  return r.code === 0 ? r.stdout.toString('utf8').trim() : '';
}

export async function isMergeInProgress(root: string): Promise<boolean> {
  const dir = path.resolve(root, (await gitText(['rev-parse', '--git-dir'], root)).trim());
  return (
    ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((f) => fs.existsSync(path.join(dir, f))) ||
    fs.existsSync(path.join(dir, 'rebase-merge')) ||
    fs.existsSync(path.join(dir, 'rebase-apply'))
  );
}

const splitZ = (b: Buffer) => b.toString('utf8').split('\0').filter(Boolean).map(normalizePath);

export async function stagedFiles(root: string): Promise<string[]> {
  return splitZ((await git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root)).stdout);
}

export async function unstagedFiles(root: string): Promise<string[]> {
  return splitZ((await git(['diff', '--name-only', '-z'], root)).stdout);
}

export async function trackedFiles(root: string): Promise<string[]> {
  return splitZ((await git(['ls-files', '-z'], root)).stdout);
}

export async function stageFiles(root: string, files: string[]): Promise<void> {
  for (let i = 0; i < files.length; i += 100) {
    await git(['add', '--', ...files.slice(i, i + 100)], root);
  }
}

export interface AddedLine {
  line: number;
  text: string;
}

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p);
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

/** Parse `git diff -U0` output into added lines per file (new-file line numbers). */
export function parseAddedLines(diff: string): Map<string, AddedLine[]> {
  const result = new Map<string, AddedLine[]>();
  let file: string | undefined;
  let inHunk = false;
  let lineNo = 0;
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      file = undefined;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const p = unquote(line.slice(4).trim());
        file = p === '/dev/null' ? undefined : normalizePath(p.replace(/^b\//, ''));
        if (file && !result.has(file)) result.set(file, []);
        continue;
      }
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      inHunk = true;
      lineNo = Number(m[1]);
      continue;
    }
    if (!inHunk || !file) continue;
    if (line.startsWith('+')) {
      result.get(file)!.push({ line: lineNo, text: line.slice(1) });
      lineNo++;
    } else if (line.startsWith(' ')) lineNo++;
  }
  return result;
}

export interface FileSet {
  mode: 'staged' | 'all';
  root: string;
  files: string[];
  /** Added lines per file. In `all` mode every line counts as added. */
  addedLines(file: string): Promise<AddedLine[]>;
  read(file: string): Promise<Buffer | undefined>;
  size(file: string): Promise<number>;
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function stagedFileSet(root: string): Promise<FileSet> {
  const files = await stagedFiles(root);
  const diff = files.length
    ? (await git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR', '--ignore-submodules'], root)).stdout.toString('utf8')
    : '';
  const added = parseAddedLines(diff);
  const blobCache = new Map<string, Promise<Buffer | undefined>>();
  const read = (file: string) => {
    let p = blobCache.get(file);
    if (!p) {
      p = git(['show', `:${file}`], root).then((r) => (r.code === 0 ? r.stdout : undefined));
      blobCache.set(file, p);
    }
    return p;
  };
  return {
    mode: 'staged',
    root,
    files,
    addedLines: async (f) => added.get(f) ?? [],
    read,
    size: async (f) => {
      const r = await git(['cat-file', '-s', `:${f}`], root);
      return r.code === 0 ? Number(r.stdout.toString().trim()) : 0;
    },
  };
}

export async function workingTreeFileSet(root: string, files?: string[]): Promise<FileSet> {
  const list = files ?? (await trackedFiles(root)).filter((f) => fs.existsSync(path.join(root, f)));
  const read = async (f: string) => {
    try {
      return await fs.promises.readFile(path.join(root, f));
    } catch {
      return undefined;
    }
  };
  return {
    mode: 'all',
    root,
    files: list,
    read,
    addedLines: async (f) => {
      const buf = await read(f);
      if (!buf || isBinary(buf)) return [];
      return buf
        .toString('utf8')
        .split('\n')
        .map((t, i) => ({ line: i + 1, text: t.endsWith('\r') ? t.slice(0, -1) : t }));
    },
    size: async (f) => {
      try {
        return (await fs.promises.stat(path.join(root, f))).size;
      } catch {
        return 0;
      }
    },
  };
}
