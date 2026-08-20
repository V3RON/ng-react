// Minimal glob matcher for the small set of patterns this preset's rules
// need for their filename-based exemptions (composition root, test files,
// contract files): `**`, `*`, `?`, and one level of `{a,b,c}` alternation —
// e.g. `**/composition-root.{ts,tsx}`, `**/*.test.{ts,tsx}`, `**/test/**`.
//
// Deliberately not a general-purpose glob engine (no `!negation`, no nested
// braces, no `[abc]` classes): every default and every documented option in
// this preset only ever needs the patterns above, and pulling in a real glob
// dependency (minimatch/picomatch) for that is not worth the extra
// dependency surface on a lint preset. If a consumer needs more, they can
// pass an already-expanded pattern list.

const REGEXP_SPECIAL = new Set(['.', '+', '^', '$', '(', ')', '|', '[', ']', '\\']);

/**
 * Converts one glob pattern into an anchored `RegExp` matched against a `/`-joined path.
 * @param {string} glob
 */
function globToRegExp(glob) {
  let pattern = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === undefined) {
      break; // unreachable given the `i < glob.length` guard above; satisfies noUncheckedIndexedAccess.
    }
    if (c === '*' && glob[i + 1] === '*') {
      pattern += '.*';
      i += 2;
    } else if (c === '*') {
      pattern += '[^/]*';
      i += 1;
    } else if (c === '?') {
      pattern += '[^/]';
      i += 1;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        pattern += '\\{';
        i += 1;
        continue;
      }
      const options = glob
        .slice(i + 1, end)
        .split(',')
        .map((/** @type {string} */ opt) => opt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      pattern += `(?:${options.join('|')})`;
      i = end + 1;
    } else if (REGEXP_SPECIAL.has(c)) {
      pattern += `\\${c}`;
      i += 1;
    } else {
      pattern += c;
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * True if `filename` (an absolute or relative path, any OS separator) matches
 * any pattern in `patterns`.
 * @param {string} filename
 * @param {readonly string[]} patterns
 */
export function matchesAnyGlob(filename, patterns) {
  const normalized = filename.split('\\').join('/');
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}
