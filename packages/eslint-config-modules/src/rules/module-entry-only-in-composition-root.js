// B1 (spec §4, §13): "`./module` may be imported only by the application's
// composition root." `no-cross-module-deep-import` already restricts
// *which* subpaths of a module package are importable at all (only
// `contract` and `module`); this rule restricts *where* `/module` in
// particular may be imported from, since it is the descriptor entry point —
// importing it anywhere else would let ordinary feature code trigger
// evaluation of another module's implementation thunks, defeating D1.

import { createRule } from '../utils/create-rule.js';
import { matchesAnyGlob } from '../utils/glob.js';

const DEFAULT_MODULE_PATTERN = '^@app/';
const DEFAULT_COMPOSITION_ROOT = ['**/composition-root.{ts,tsx}', '**/main.tsx'];

/** @typedef {{ modulePattern?: string, compositionRoot?: readonly string[] }} Options */

export const moduleEntryOnlyInCompositionRoot = createRule({
  name: 'module-entry-only-in-composition-root',
  meta: {
    type: 'problem',
    docs: {
      description:
        "B1: '<pkg>/module' — the descriptor entry point — may be imported only from the composition root " +
        "glob(s); every other importer must use '<pkg>/contract'.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          modulePattern: { type: 'string' },
          compositionRoot: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      moduleEntryOutsideCompositionRoot:
        "'{{specifier}}' imports '{{pkg}}/module' — the descriptor entry point, reserved for the composition " +
        "root ({{compositionRootGlobs}}) because importing it evaluates the module's registration surface " +
        "(spec D1, §4). Import '{{pkg}}/contract' here instead, or move this file into the composition root.",
    },
  },
  defaultOptions: /** @type {[Options]} */ ([
    { modulePattern: DEFAULT_MODULE_PATTERN, compositionRoot: DEFAULT_COMPOSITION_ROOT },
  ]),
  create(context, [options]) {
    const modulePattern = new RegExp(options.modulePattern ?? DEFAULT_MODULE_PATTERN);
    const compositionRoot = options.compositionRoot ?? DEFAULT_COMPOSITION_ROOT;

    if (matchesAnyGlob(context.filename, compositionRoot)) {
      return {};
    }

    /**
     * @param {import('@typescript-eslint/utils').TSESTree.Node} node
     * @param {string} specifier
     */
    function checkSpecifier(node, specifier) {
      const match = modulePattern.exec(specifier);
      if (!match) {
        return;
      }
      const rest = specifier.slice(match[0].length);
      const [pkg, ...subpathParts] = rest.split('/');
      if (!pkg || subpathParts.join('/') !== 'module') {
        return;
      }
      context.report({
        node,
        messageId: 'moduleEntryOutsideCompositionRoot',
        data: { specifier, pkg, compositionRootGlobs: compositionRoot.join(', ') },
      });
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
