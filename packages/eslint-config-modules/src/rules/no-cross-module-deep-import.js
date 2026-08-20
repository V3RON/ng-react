// B1 (spec §13, §4): "Imports across module packages are allowed only from
// <pkg>/contract." This is the backstop for resolvers that ignore package
// `exports` maps (§4) — primary enforcement is the resolver itself.
//
// Two independent things reach past a module boundary and are rejected here:
//  1. A package-specifier import matching `modulePattern` whose subpath is
//     neither `contract` nor `module` (or has no subpath at all — packages
//     have no root export, spec §4).
//  2. A relative import that, once resolved against the importing file's
//     location, lands inside a *different* package's `src/` — i.e. reaches
//     across the workspace by counting `../` instead of using the package's
//     name, which the package-specifier check above cannot see at all.
//
// `<pkg>/module` is accepted here (case 1) because *that* restriction is
// "only from the composition root", which is a different axis (location of
// the importer, not shape of the specifier) — see
// `module-entry-only-in-composition-root`.

import path from 'node:path';
import { createRule } from '../utils/create-rule.js';

const DEFAULT_MODULE_PATTERN = '^@app/';
// Matches the `<name>` segment of a conventional `packages/<name>/...` or
// `apps/<name>/...` monorepo path. Deliberately string-pattern based, not
// filesystem-based (no package.json walk): RuleTester cases use synthetic
// filenames that do not exist on disk, and the real workspace already
// follows this convention (`AGENTS.md` §1).
const PACKAGE_ROOT_PATTERN = '(?:packages|apps)/([^/]+)/';

/** @typedef {{ modulePattern?: string }} Options */

export const noCrossModuleDeepImport = createRule({
  name: 'no-cross-module-deep-import',
  meta: {
    type: 'problem',
    docs: {
      description:
        "B1: cross-module imports are allowed only via '<pkg>/contract' (or '<pkg>/module' from the " +
        'composition root). Rejects any other package subpath and any relative import that reaches into ' +
        "another package's src/.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          modulePattern: {
            type: 'string',
            description: 'Regex (as a string) matching the start of a module-package import specifier.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      deepImportSpecifier:
        "'{{specifier}}' imports past the module boundary of '{{pkg}}'. Only '{{pkg}}/contract' may be " +
        "imported from other modules ('{{pkg}}/module' is reserved for the composition root). " +
        "Import '{{suggestion}}' instead.",
      bareModuleImport:
        "'{{specifier}}' imports the package root, which '{{pkg}}' does not export (spec §4: module packages " +
        "have no root export). Import '{{suggestion}}' instead.",
      relativeEscape:
        "'{{specifier}}' is a relative import that reaches into another package's src/ ('{{targetPkg}}'), " +
        "bypassing its module boundary entirely. Import '{{targetPkg}}/contract' as a package specifier instead " +
        'of a relative path across packages.',
    },
  },
  defaultOptions: /** @type {[Options]} */ ([{ modulePattern: DEFAULT_MODULE_PATTERN }]),
  create(context, [options]) {
    const modulePattern = new RegExp(options.modulePattern ?? DEFAULT_MODULE_PATTERN);
    const packageRootPattern = new RegExp(PACKAGE_ROOT_PATTERN);

    /**
     * @param {import('@typescript-eslint/utils').TSESTree.Node} node
     * @param {string} specifier
     */
    function checkRelative(node, specifier) {
      const filename = context.filename.split('\\').join('/');
      const currentMatch = packageRootPattern.exec(filename);
      if (!currentMatch) {
        return; // Not inside a recognizable packages/<name>/ or apps/<name>/ layout.
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
      const targetMatch = packageRootPattern.exec(resolved);
      if (!targetMatch) {
        return;
      }
      const currentPkg = currentMatch[1];
      const targetPkg = targetMatch[1];
      if (currentPkg === targetPkg) {
        return; // Same package — an ordinary internal relative import.
      }
      if (!resolved.includes(`/${targetPkg}/src/`)) {
        return; // Crosses a package boundary but not into its src/ (e.g. package.json) — not this rule's concern.
      }
      context.report({ node, messageId: 'relativeEscape', data: { specifier, targetPkg } });
    }

    /**
     * @param {import('@typescript-eslint/utils').TSESTree.Node} node
     * @param {string} specifier
     */
    function checkSpecifier(node, specifier) {
      if (specifier.startsWith('.')) {
        checkRelative(node, specifier);
        return;
      }
      const match = modulePattern.exec(specifier);
      if (!match) {
        return;
      }
      const prefix = specifier.slice(0, match[0].length);
      const rest = specifier.slice(match[0].length);
      const [pkg, ...subpathParts] = rest.split('/');
      if (!pkg) {
        return;
      }
      const subpath = subpathParts.join('/');
      const suggestion = `${prefix}${pkg}/contract`;
      if (subpath === '') {
        context.report({ node, messageId: 'bareModuleImport', data: { specifier, pkg, suggestion } });
        return;
      }
      if (subpath === 'contract' || subpath === 'module') {
        return;
      }
      context.report({ node, messageId: 'deepImportSpecifier', data: { specifier, pkg, suggestion } });
    }

    return {
      ImportDeclaration(node) {
        checkSpecifier(node.source, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          checkSpecifier(node.source, node.source.value);
        }
      },
      ExportAllDeclaration(node) {
        checkSpecifier(node.source, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          checkSpecifier(node.source, node.source.value);
        }
      },
    };
  },
});
