import * as fs from 'node:fs';
import * as path from 'node:path';
import { git } from '../git';
import { normalizePath } from '../glob';

/**
 * Monorepo helpers: tools (Biome, Prettier, lint-staged, CSharpier, package.json scripts, solutions)
 * are often configured in a sub-folder rather than at the repository root. These helpers find the
 * folder that "owns" each staged file so a tool can be run from the right place.
 */

/** Read and parse a JSON file, or undefined. */
export function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function readPackageJson(dir: string): Record<string, unknown> | undefined {
  return readJsonFile(path.join(dir, 'package.json'));
}

/** True when `pkg` lists `dep` in dependencies or devDependencies. */
export function hasDependency(pkg: Record<string, unknown> | undefined, dep: string): boolean {
  if (!pkg) return false;
  const d = pkg.dependencies as Record<string, unknown> | undefined;
  const dd = pkg.devDependencies as Record<string, unknown> | undefined;
  return !!(d?.[dep] ?? dd?.[dep]);
}

/** Repo-relative directory ('' for the root) → absolute path. */
export const absDir = (root: string, rel: string) => (rel ? path.join(root, rel) : root);

/**
 * Walk up from the directory of a repo-relative `file` to the repo root and return the first
 * repo-relative directory ('' = root) for which `test` is true.
 */
export function findOwnerDir(root: string, file: string, test: (abs: string, rel: string) => boolean, cache?: Map<string, boolean>): string | undefined {
  let rel = normalizePath(path.posix.dirname(normalizePath(file)));
  if (rel === '.') rel = '';
  for (;;) {
    let ok = cache?.get(rel);
    if (ok === undefined) {
      ok = test(absDir(root, rel), rel);
      cache?.set(rel, ok);
    }
    if (ok) return rel;
    if (!rel) return undefined;
    const up = path.posix.dirname(rel);
    rel = up === '.' ? '' : up;
  }
}

/**
 * Group repo-relative files by their owning directory (see findOwnerDir). Files without an owner are
 * dropped. Directories are returned in sorted order; '' (the root) comes first.
 */
export function groupByOwnerDir(root: string, files: string[], test: (abs: string, rel: string) => boolean): Map<string, string[]> {
  const cache = new Map<string, boolean>();
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const owner = findOwnerDir(root, f, test, cache);
    if (owner === undefined) continue;
    const list = groups.get(owner);
    if (list) list.push(f);
    else groups.set(owner, [f]);
  }
  return new Map([...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Path of a repo-relative file relative to a repo-relative directory (for passing to a tool run in that directory). */
export function relativeTo(dir: string, file: string): string {
  return dir ? normalizePath(path.posix.relative(dir, normalizePath(file))) : normalizePath(file);
}

// ---------------------------------------------------------------- tracked file index

const INDEX_TTL_MS = 3000;
const indexCache = new Map<string, { at: number; files: Promise<string[]> }>();

/**
 * Tracked files anywhere in the repo whose basename matches one of the names tool detection cares
 * about (package.json, biome.json, .prettierrc, …). Cached briefly — detection runs once per check
 * and the editor refreshes often.
 */
export function trackedToolFiles(root: string): Promise<string[]> {
  const hit = indexCache.get(root);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.files;
  const files = git(
    [
      'ls-files',
      '-z',
      '--',
      '*package.json',
      '*biome.json',
      '*biome.jsonc',
      '*.prettierrc*',
      '*prettier.config.*',
      '*.lintstagedrc*',
      '*lint-staged.config.*',
      '*dotnet-tools.json',
      '*.csharpierrc*',
    ],
    root,
  ).then((r) =>
    r.code === 0
      ? r.stdout
          .toString('utf8')
          .split('\0')
          .filter(Boolean)
          .map(normalizePath)
          .filter((f) => !/(^|\/)node_modules\//.test(f))
      : [],
  );
  indexCache.set(root, { at: Date.now(), files });
  return files;
}

/** Testing hook. */
export function resetToolFileCache(): void {
  indexCache.clear();
}

/** Repo-relative directories (sorted, '' = root) containing a tracked file for which `match(basename, relPath)` is true. */
export async function trackedDirsWith(root: string, match: (base: string, rel: string) => boolean): Promise<string[]> {
  const dirs = new Set<string>();
  for (const f of await trackedToolFiles(root)) {
    if (!match(path.posix.basename(f), f)) continue;
    const d = path.posix.dirname(f);
    dirs.add(d === '.' ? '' : d);
  }
  return [...dirs].sort();
}
