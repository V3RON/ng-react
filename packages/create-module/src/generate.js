// Spec §13 **B4** — the emitted file set, rendered from the templates in
// `../templates/module/`.
//
// Templates are real files, not string literals in this file. That is a
// requirement of the task and it buys two things: a human can read the
// blessed patterns straight out of the repo, and the root `eslint .` lints
// them like any other source file. What it costs is stated plainly here:
// a template is *not* type-checked, because three of its placeholders sit in
// type positions (`load: '__load__'`, `critical: __critical__`,
// `dependsOn: [__dependsOn__]`) and cannot be valid TypeScript as written.
// The machine-checked artefact is `__fixtures__/demo-thing/`, a byte-for-byte
// copy of this function's output that `tsc`, `eslint` and `vitest` all see.
//
// This module does no I/O beyond reading its own templates: it returns the
// file list, and `cli.js` decides whether to write it or print it. That split
// is what makes `--dry-run` exact rather than approximate — both paths render
// the same bytes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { CreateModuleError } from './errors.js';
import { toCamelCase, toPascalCase, toRefName, validateModuleId } from './id.js';

const TEMPLATE_ROOT = fileURLToPath(new URL('../templates/module/', import.meta.url));

/** The emitted files, in the order `--dry-run` prints them. Spec §13 B4's list. */
const TEMPLATE_FILES = Object.freeze([
  'package.json',
  'tsconfig.json',
  'src/contract.ts',
  'src/module.ts',
  'src/providers.ts',
  'src/lifecycle.ts',
  'src/module.test.ts',
]);

/**
 * Placeholders that occupy a whole line and are dropped with it when empty,
 * keyed by the exact (trimmed) line they are written as in the template.
 *
 * They are written as comments so the template file stays lint-clean: a bare
 * `__dependsOnImports__` on its own line is an expression statement, and
 * `@typescript-eslint/no-unused-expressions` rejects it. The whole reason
 * templates are real files is that the root `eslint .` sees them, so a
 * placeholder that only works by being unlintable would defeat the point.
 */
const LINE_PLACEHOLDERS = Object.freeze({
  '// __dependsOnImports__': '__dependsOnImports__',
});

/** @typedef {{ readonly path: string, readonly contents: string }} GeneratedFile */

/**
 * @typedef {object} GenerateOptions
 * @property {string} id the module id — kebab-case, not `'app'` (ADR-2).
 * @property {string} [scope] npm scope for the package name. Default `'@app'`.
 * @property {string} [dir] the workspace directory the package is created in. Default `'packages'`.
 * @property {'eager' | 'lazy'} [load] the spec section 6 load strategy. Default `'lazy'`.
 * @property {boolean} [critical] the spec section 10 failure policy. Default `false`.
 * @property {readonly string[]} [dependsOn] D3 dependency ids.
 */

/**
 * @typedef {object} GeneratedModule
 * @property {string} id
 * @property {string} packageName
 * @property {string} dir the package directory, relative to the workspace root.
 * @property {readonly GeneratedFile[]} files paths relative to the workspace root.
 */

/**
 * Renders the module package for `options`. Pure: validates, reads templates,
 * substitutes, returns bytes. Nothing is written and nothing on disk is read
 * except the templates.
 *
 * @param {GenerateOptions} options
 * @returns {GeneratedModule}
 * @throws {CreateModuleError} for an invalid id, scope, load strategy or dependency.
 */
export function generateModule(options) {
  const id = validateModuleId(options.id);
  const scope = options.scope ?? '@app';
  if (!/^@[a-z0-9][a-z0-9-]*$/.test(scope)) {
    throw new CreateModuleError(
      `create-module: invalid --scope '${scope}'. A scope is '@' followed by a lowercase npm name, e.g. ` +
        `'@app'. Spec §4: "the package name is the module id prefixed by the workspace scope".`,
    );
  }
  const load = options.load ?? 'lazy';
  if (load !== 'eager' && load !== 'lazy') {
    throw new CreateModuleError(
      `create-module: invalid --load '${load}'. Valid values are 'eager' and 'lazy' (spec §5.2, §6); ` +
        `'lazy' is the default and the one a feature module almost always wants.`,
    );
  }
  const critical = options.critical ?? false;

  const dependsOn = (options.dependsOn ?? []).map((dep) => validateModuleId(dep, '--depends-on entry'));
  const seen = new Set();
  for (const dep of dependsOn) {
    if (dep === id) {
      throw new CreateModuleError(
        `create-module: --depends-on lists '${dep}', which is the module's own id. A module cannot depend ` +
          `on itself (D3), and defineModule() rejects it at runtime.`,
      );
    }
    if (seen.has(dep)) {
      throw new CreateModuleError(
        `create-module: --depends-on lists '${dep}' twice. Each dependency may be listed only once (D3).`,
      );
    }
    seen.add(dep);
  }

  const dir = options.dir ?? 'packages';
  const packageName = `${scope}/${id}`;
  const packageDir = path.posix.join(dir, id);

  const substitutions = {
    __pkg__: packageName,
    __Pascal__: toPascalCase(id),
    __camel__: toCamelCase(id),
    __Ref__: toRefName(id),
    __id__: id,
    __load__: load,
    __critical__: String(critical),
    __dependsOn__: dependsOn.map(toRefName).join(', '),
    __dependsOnImports__: dependsOn
      .map((dep) => `import { ${toRefName(dep)} } from '${scope}/${dep}/contract';`)
      .join('\n'),
  };

  const files = TEMPLATE_FILES.map((relativePath) => ({
    path: path.posix.join(packageDir, relativePath),
    contents: render(fs.readFileSync(path.join(TEMPLATE_ROOT, relativePath), 'utf8'), substitutions),
  }));

  return { id, packageName, dir: packageDir, files: Object.freeze(files) };
}

/**
 * Substitutes `__name__` placeholders.
 *
 * Two passes, because they are not the same operation. A placeholder that
 * occupies a whole line (`__dependsOnImports__`) has to take the line with it
 * when its value is empty, or a module with no dependencies would be emitted
 * with a stray blank line inside its import block — and the golden fixture
 * would then differ from the file a human would have written by hand. Every
 * other placeholder is a plain textual substitution, applied longest-key-first
 * so no key can be a prefix of another one's match.
 *
 * @param {string} template
 * @param {Record<string, string>} substitutions
 */
function render(template, substitutions) {
  const lines = template.split('\n').flatMap((line) => {
    const placeholder = LINE_PLACEHOLDERS[/** @type {keyof typeof LINE_PLACEHOLDERS} */ (line.trim())];
    if (placeholder === undefined) {
      return [line];
    }
    const value = substitutions[placeholder] ?? '';
    return value === '' ? [] : value.split('\n');
  });

  let rendered = lines.join('\n');
  for (const key of Object.keys(substitutions).sort((a, b) => b.length - a.length)) {
    rendered = rendered.split(key).join(/** @type {string} */ (substitutions[key]));
  }
  return rendered;
}
