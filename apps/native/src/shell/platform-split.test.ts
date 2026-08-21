// **The guard on the platform split's native half.**
//
// #52 left four `screen.native.tsx` files as documented placeholders — plain
// React with a `data-platform="native"` marker — because there was no React
// Native in the workspace to write them against. `apps/react/src/shell/dashboard.test.tsx`
// guards the *web* half: it asserts that a `.native.tsx` exists beside each
// `.web.tsx` (so the resolution test has something to resolve away from) and
// that every rendered component carries `data-platform="web"`.
//
// This file is the missing counterpart, and it guards the exact regression #53
// was needed to fix in the first place: **a `.native.tsx` file that is not
// actually React Native.** A placeholder compiles, type-checks under both
// programs, passes every collection test in this repository, and crashes on
// device — which is precisely the failure mode that went unnoticed for a whole
// PR, because nothing could run it.
//
// **What it is not.** It is not a proof that Metro *picks* these files. Metro's
// resolution is verified two ways and neither of them is a unit test: the
// exported iOS bundle contains four `platform: native` markers and zero
// `data-platform` ones (recorded in the PR body), and the app runs in the
// simulator. That split is stated here rather than left implicit, because a
// test named "the platform split works" that only reads files would be exactly
// the vacuous check `HANDOFF.md` §5.2 warns about.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages');

/** Every package that owns a platform-split component, discovered rather than listed. */
function packagesWithNativeScreens(): readonly string[] {
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return readdirSync(join(packagesRoot, name, 'src')).includes('screen.native.tsx');
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * The file with its comments removed.
 *
 * Load-bearing rather than tidy: every file in this workspace explains itself
 * at length, and `screen.native.tsx` legitimately *mentions* `data-platform`
 * and `<section>` while describing the web sibling it replaced. Matching
 * against the raw text would fail on the prose, so the check would have to be
 * weakened to something that no longer catches the regression — the exact
 * trade `HANDOFF.md` §5.2 describes. Stripping first keeps the assertion sharp.
 */
function codeOf(source: string): string {
  // **Line comments first, then block comments — the order is load-bearing.**
  // These file headers legitimately contain `**/*.native.tsx` in prose, and
  // that `/*` opens a block-comment match that runs to the next `*/` — which
  // is the end of the first JSDoc, several dozen lines and every `import`
  // later. Stripping `//` lines first removes the false opener.
  //
  // And `[ \t]*`, not `\s*`: with the `m` flag `^\s*` happily consumes the
  // newlines *between* lines before matching `//`, deleting whole blocks of
  // real code that merely precede a comment.
  return source.replace(/^[ \t]*\/\/.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** The names a file exports, by the one declaration form this repository allows (no default exports). */
function exportedNames(source: string): readonly string[] {
  return [...source.matchAll(/export function (\w+)/g)].map((match) => match[1] ?? '').sort();
}

describe('the platform split, native half', () => {
  // Discovered, not hard-coded, so a fifth contributing package is covered the
  // moment someone writes one — but pinned to the four that exist, so deleting
  // a `.native.tsx` cannot make this file quietly assert nothing about zero
  // packages.
  const packages = packagesWithNativeScreens();

  it('covers exactly the packages that own a platform-split component', () => {
    expect(packages).toEqual(['dashboard', 'debug', 'orders', 'payments']);
  });

  it.each(packagesWithNativeScreens())(
    '@app/%s: the .native.tsx is React Native, not a placeholder that happens to compile',
    (name) => {
      const native = codeOf(
        readFileSync(join(packagesRoot, name, 'src', 'screen.native.tsx'), 'utf8'),
      );
      // The assertion that would have failed against #52's placeholders, which
      // imported only `react` and rendered `<section data-platform="native" />`.
      expect(native).toMatch(/from 'react-native'/);
      expect(native).not.toMatch(/data-platform=/);
      // A DOM intrinsic in a native file is a crash on device that no
      // type-checker in this workspace catches: `@types/react`'s
      // `JSX.IntrinsicElements` is present whether or not `lib` includes DOM.
      expect(native).not.toMatch(/<(section|div|p|ul|li|h[1-6]|button)[\s>]/);
    },
  );

  it.each(packagesWithNativeScreens())(
    '@app/%s: the two platform files export the same components, so one contribute() call fits both',
    (name) => {
      const native = codeOf(
        readFileSync(join(packagesRoot, name, 'src', 'screen.native.tsx'), 'utf8'),
      );
      const web = codeOf(readFileSync(join(packagesRoot, name, 'src', 'screen.web.tsx'), 'utf8'));
      // The property the whole decision rests on: `providers.ts` imports
      // `./screen` once and destructures the same names on every platform. A
      // component added to one file and not the other is a resolution-dependent
      // `undefined` — which surfaces as a blank screen on one platform only.
      expect(exportedNames(native)).toEqual(exportedNames(web));
      expect(exportedNames(native).length).toBeGreaterThan(0);
    },
  );

  it.each(packagesWithNativeScreens())(
    '@app/%s: react-native is a real dependency, not a devDependency',
    (name) => {
      // `screen.native.tsx` is reached at *runtime* by anything that activates
      // the module on a native host, so `react-native` is a dependency in the
      // ordinary sense. As a devDependency it would resolve for `tsc` and for
      // Metro in this workspace and fail for a consumer — the class of mistake
      // pnpm's strict `node_modules` exists to catch and would not catch here,
      // because the native app hoists it anyway.
      const manifest: unknown = JSON.parse(
        readFileSync(join(packagesRoot, name, 'package.json'), 'utf8'),
      );
      const dependencies = (manifest as { dependencies?: Record<string, string> }).dependencies;
      expect(dependencies?.['react-native']).toBeDefined();
    },
  );

  it('the packages that own no component have no react-native dependency', () => {
    // `@app/auth` contributes a menu entry and nothing else, and `@app/nav`
    // owns a *web* navigator. Neither should have acquired `react-native` as a
    // side effect of this task — a dependency added "just in case" is how a
    // platform-neutral package stops being one.
    for (const name of ['auth', 'nav', 'ng-react']) {
      const manifest: unknown = JSON.parse(
        readFileSync(join(packagesRoot, name, 'package.json'), 'utf8'),
      );
      const dependencies = (manifest as { dependencies?: Record<string, string> }).dependencies;
      expect(dependencies?.['react-native']).toBeUndefined();
    }
  });
});
