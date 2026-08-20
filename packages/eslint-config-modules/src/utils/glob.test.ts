import { describe, expect, it } from 'vitest';
import { matchesAnyGlob } from './glob.js';

describe('matchesAnyGlob', () => {
  it('matches `**/name.ts` against any depth, including a single directory', () => {
    expect(matchesAnyGlob('/repo/apps/main/src/composition-root.ts', ['**/composition-root.ts'])).toBe(true);
    expect(matchesAnyGlob('/repo/composition-root.ts', ['**/composition-root.ts'])).toBe(true);
  });

  it('requires at least one path separator before the matched basename', () => {
    expect(matchesAnyGlob('composition-root.ts', ['**/composition-root.ts'])).toBe(false);
  });

  it('expands one level of {a,b} alternation', () => {
    expect(matchesAnyGlob('/repo/src/composition-root.ts', ['**/composition-root.{ts,tsx}'])).toBe(true);
    expect(matchesAnyGlob('/repo/src/composition-root.tsx', ['**/composition-root.{ts,tsx}'])).toBe(true);
    expect(matchesAnyGlob('/repo/src/composition-root.jsx', ['**/composition-root.{ts,tsx}'])).toBe(false);
  });

  it('matches `**/test/**` for anything under a test/ directory', () => {
    expect(matchesAnyGlob('/repo/packages/orders/test/helpers.ts', ['**/test/**'])).toBe(true);
    expect(matchesAnyGlob('/repo/packages/orders/src/helpers.ts', ['**/test/**'])).toBe(false);
  });

  it('normalizes Windows-style separators before matching', () => {
    expect(matchesAnyGlob('C:\\repo\\apps\\main\\src\\composition-root.ts', ['**/composition-root.ts'])).toBe(true);
  });

  it('returns true if any pattern in the list matches', () => {
    expect(matchesAnyGlob('/repo/src/main.tsx', ['**/composition-root.ts', '**/main.tsx'])).toBe(true);
  });

  it('returns false when nothing matches', () => {
    expect(matchesAnyGlob('/repo/src/widget.tsx', ['**/composition-root.ts', '**/main.tsx'])).toBe(false);
  });
});
