// R2, B3 (spec §12): "transient resolution via useService is a warning."
//
// KNOWN LIMITATION — read before relying on this rule (issue #21 asked for
// this to be documented in the rule docs, not just implied by severity):
// whether a given token's provider is `scope: 'transient'` is a registration
// -time fact that lives wherever `provide(Token, { scope: 'transient' })` is
// called, which in real code is almost always a *different file* than the
// component calling `useService(Token)` — often in a different package
// altogether, reached only via the token's declared type. Static analysis of
// one file has no reliable way to see that. This rule therefore only
// implements the achievable slice: it flags `useService(Token)` when the
// *same file* also contains a `provide(Token, { scope: 'transient', ... })`
// call — e.g. a colocated fixture, demo, or small single-file feature. A
// transient provider declared anywhere else is invisible to this rule. A
// clean run of this rule is not evidence that no transient token is misused
// this way — it only proves the same-file case doesn't occur. Tightening
// this further (e.g. tracing the token's type back to its `provide()` call
// across files) would need a type-aware, whole-project pass this preset does
// not attempt.
//
// `provide`/`useService` are matched by identifier name only, consistent
// with `no-override-outside-composition-root` — see that rule's file for
// why import-provenance verification (as `contract-exports-allowlist` does)
// was not added here too.

import { createRule } from '../utils/create-rule.js';

/**
 * Narrows an arbitrary value produced by the generic tree-walk below to an
 * ESTree/TSESTree node — i.e. anything with a string `type` field.
 * @param {unknown} value
 * @returns {value is import('@typescript-eslint/utils').TSESTree.Node}
 */
function isNode(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (/** @type {{ type?: unknown }} */ (value).type) === 'string'
  );
}

export const noTransientInComponent = createRule({
  name: 'no-transient-in-component',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        "R2: useService(Token) loses referential stability across renders when Token's provider is " +
        "scope: 'transient'. Same-file heuristic only — see the top-of-file comment on this rule for why a " +
        'general check is not achievable, and what this rule does and does not catch.',
    },
    schema: [],
    messages: {
      transientInComponent:
        "useService({{token}}) resolves a provider registered scope: 'transient' in this same file — a new " +
        'instance is constructed on every resolution, so the value is not referentially stable across renders ' +
        '(R2). Resolve it inside an event handler or ctx.effect() instead of at component top level. (This rule ' +
        'only sees provide() calls in the same file; a transient provider declared elsewhere is not caught — see ' +
        "this rule's docs.)",
    },
  },
  defaultOptions: [],
  create(context) {
    /** @type {Set<string>} */
    const transientTokenNames = new Set();

    /**
     * Finds the token name of a `provide(Token, { scope: 'transient', ... })` call, else `null`.
     * @param {import('@typescript-eslint/utils').TSESTree.Node} node
     */
    function transientTokenOf(node) {
      if (
        node.type !== 'CallExpression' ||
        node.callee.type !== 'Identifier' ||
        node.callee.name !== 'provide'
      ) {
        return null;
      }
      const [tokenArg, optionsArg] = node.arguments;
      if (!tokenArg || tokenArg.type !== 'Identifier' || !optionsArg || optionsArg.type !== 'ObjectExpression') {
        return null;
      }
      const scopeProp = optionsArg.properties.find(
        (p) => p.type === 'Property' && !p.computed && p.key.type === 'Identifier' && p.key.name === 'scope',
      );
      if (!scopeProp || scopeProp.type !== 'Property') {
        return null;
      }
      if (scopeProp.value.type !== 'Literal' || scopeProp.value.value !== 'transient') {
        return null;
      }
      return tokenArg.name;
    }

    // Plain-object recursive walk (not ESLint's own traversal) so every
    // `provide()` call in the file is found up front — regardless of how
    // deeply it's nested (array literal, arrow function body, ...) — before
    // any `useService()` call is checked below. `Program` always visits
    // before its descendants, so this runs first.
    /** @param {unknown} value */
    function walk(value) {
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item);
        }
        return;
      }
      if (!isNode(value)) {
        return;
      }
      const tokenName = transientTokenOf(value);
      if (tokenName) {
        transientTokenNames.add(tokenName);
      }
      const record = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (value));
      for (const key of Object.keys(record)) {
        if (key === 'parent' || key === 'loc' || key === 'range') {
          continue;
        }
        walk(record[key]);
      }
    }

    return {
      Program(program) {
        walk(program);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'useService') {
          return;
        }
        const tokenArg = node.arguments[0];
        if (!tokenArg || tokenArg.type !== 'Identifier' || !transientTokenNames.has(tokenArg.name)) {
          return;
        }
        context.report({ node, messageId: 'transientInComponent', data: { token: tokenArg.name } });
      },
    };
  },
});
