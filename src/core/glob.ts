const cache = new Map<string, RegExp>();

/** Convert a glob (supports **, *, ?, {a,b}, [abc]) to a RegExp anchored to the full path. */
export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let re = '';
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const prevSlash = i === 0 || glob[i - 1] === '/';
        const nextSlash = glob[i + 2] === '/';
        if (prevSlash && nextSlash) {
          re += '(?:.*/)?';
          i += 2;
          continue;
        }
        if (prevSlash && i + 2 === glob.length) {
          re += '.*';
          i += 1;
          continue;
        }
        re += '.*';
        i += 1;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      inGroup++;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup--;
      re += ')';
    } else if (c === ',' && inGroup) re += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end > i) {
        re +=
          '[' +
          glob
            .slice(i + 1, end)
            .replace(/^!/, '^')
            .replace(/\\/g, '\\\\') +
          ']';
        i = end;
      } else re += '\\[';
    } else re += c.replace(/[.+^$()|\\\]]/g, '\\$&');
  }
  const r = new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
  cache.set(glob, r);
  return r;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchOne(file: string, pattern: string): boolean {
  const f = normalizePath(file);
  let p = normalizePath(pattern);
  if (p.startsWith('/')) p = p.slice(1);
  else if (!p.includes('/')) {
    // No slash: match the basename anywhere in the tree (gitignore semantics).
    const base = f.slice(f.lastIndexOf('/') + 1);
    return globToRegExp(p).test(base);
  }
  return globToRegExp(p).test(f);
}

/** Evaluate patterns in order; `!pattern` negates a previous match. */
export function matchesAny(file: string, patterns: string | string[] | undefined): boolean {
  if (!patterns) return false;
  const list = Array.isArray(patterns) ? patterns : [patterns];
  let matched = false;
  for (const raw of list) {
    if (!raw) continue;
    if (raw.startsWith('!')) {
      if (matched && matchOne(file, raw.slice(1))) matched = false;
    } else if (!matched && matchOne(file, raw)) matched = true;
  }
  return matched;
}
