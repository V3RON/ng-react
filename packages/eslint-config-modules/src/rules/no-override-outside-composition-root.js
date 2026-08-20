// B3, C6 (spec §7.2): "Overriding is explicit — provide(token, { override:
// true, ... }) — and is intended for the composition root and tests only; a
// lint rule flags override: true inside module packages."
//
// Detected as a literal `override: true` property in the options object of
// a `provide(...)` call (issue #21). Not import-verified (unlike
// `contract-exports-allowlist`'s moduleRef/createToken check) — `provide` is
// matched by identifier name only, which the issue does not ask this rule to
// tighten further; see the PR body for that judgement call.

import { createRule } from '../utils/create-rule.js';
import { matchesAnyGlob } from '../utils/glob.js';

const DEFAULT_COMPOSITION_ROOT = ['**/composition-root.{ts,tsx}', '**/main.tsx'];
const DEFAULT_TEST_GLOBS = ['**/*.test.{ts,tsx}', '**/test/**'];

/** @typedef {{ compositionRoot?: readonly string[], testGlobs?: readonly string[] }} Options */

export const noOverrideOutsideCompositionRoot = createRule({
  name: 'no-override-outside-composition-root',
  meta: {
    type: 'problem',
    docs: {
      description:
        'B3/C6: `override: true` on provide() is an explicit escape hatch reserved for the composition root ' +
        "and test files — anywhere else it silently replaces another module's provider outside that module's " +
        'control.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          compositionRoot: { type: 'array', items: { type: 'string' } },
          testGlobs: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      overrideOutsideCompositionRoot:
        'override: true is only allowed in the composition root ({{compositionRootGlobs}}) or test files ' +
        '({{testGlobs}}) (spec C6) — this call is in a module package. Move this override into the composition ' +
        'root, or remove override: true and change the provider being overridden instead.',
    },
  },
  defaultOptions: /** @type {[Options]} */ ([
    { compositionRoot: DEFAULT_COMPOSITION_ROOT, testGlobs: DEFAULT_TEST_GLOBS },
  ]),
  create(context, [options]) {
    const compositionRoot = options.compositionRoot ?? DEFAULT_COMPOSITION_ROOT;
    const testGlobs = options.testGlobs ?? DEFAULT_TEST_GLOBS;

    if (matchesAnyGlob(context.filename, compositionRoot) || matchesAnyGlob(context.filename, testGlobs)) {
      return {};
    }

    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'provide') {
          return;
        }
        const optionsArg = node.arguments[1];
        if (!optionsArg || optionsArg.type !== 'ObjectExpression') {
          return;
        }
        const overrideProp = optionsArg.properties.find(
          (p) => p.type === 'Property' && !p.computed && p.key.type === 'Identifier' && p.key.name === 'override',
        );
        if (!overrideProp || overrideProp.type !== 'Property') {
          return;
        }
        if (overrideProp.value.type !== 'Literal' || overrideProp.value.value !== true) {
          return;
        }
        context.report({
          node: overrideProp,
          messageId: 'overrideOutsideCompositionRoot',
          data: { compositionRootGlobs: compositionRoot.join(', '), testGlobs: testGlobs.join(', ') },
        });
      },
    };
  },
});
