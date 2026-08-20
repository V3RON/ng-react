// B2 (spec §4): "`./contract` may be imported by any module. It contains
// only types, `createToken` calls, the module's `moduleRef`, and event type
// declarations. A lint rule ... rejects any other value export from a
// contract file." Plus the M1 corollary that a contract declares *exactly
// one* moduleRef — zero means the module has no identity, two means two
// modules are tangled into one contract.
//
// `createToken`/`moduleRef` are verified by import provenance (issue #21):
// a call is only recognized if the callee name was actually imported from
// `kernelPackage` in this file, via `collectKernelImportNames`. A local
// function that happens to be named `createToken` does not count — it falls
// through to `disallowedValueExport` like any other value.

import { createRule } from '../utils/create-rule.js';
import { matchesAnyGlob } from '../utils/glob.js';
import { collectKernelImportNames } from '../utils/kernel-imports.js';

/** @typedef {import('@typescript-eslint/utils').TSESTree} TSESTree */

const DEFAULT_KERNEL_PACKAGE = '@ng-react/kernel';
const DEFAULT_CONTRACT_GLOB = ['**/contract.ts'];

/** @typedef {{ kernelPackage?: string, contractGlob?: readonly string[] }} Options */
/** @typedef {'type' | 'moduleRef' | 'createToken' | 'other'} LocalKind */

/**
 * @param {import('@typescript-eslint/utils').TSESTree.Node} node
 * @returns {node is import('@typescript-eslint/utils').TSESTree.TSTypeAliasDeclaration | import('@typescript-eslint/utils').TSESTree.TSInterfaceDeclaration}
 */
function isTypeDeclaration(node) {
  return node.type === 'TSTypeAliasDeclaration' || node.type === 'TSInterfaceDeclaration';
}

/**
 * Unwraps `as`/`satisfies`/`!` so `moduleRef('x') as ModuleRef<'x'>` is still seen as a call.
 * @param {import('@typescript-eslint/utils').TSESTree.Node | null | undefined} node
 */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression')
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * If `node` is a call to one of `verifiedNames`, returns the callee name; otherwise `null`.
 * @param {import('@typescript-eslint/utils').TSESTree.Node | null | undefined} node
 * @param {Set<string>} verifiedNames
 */
function verifiedCallName(node, verifiedNames) {
  const expr = unwrap(node);
  if (!expr || expr.type !== 'CallExpression' || expr.callee.type !== 'Identifier') {
    return null;
  }
  return verifiedNames.has(expr.callee.name) ? expr.callee.name : null;
}

/** @param {import('@typescript-eslint/utils').TSESTree.ExportSpecifier} specifier */
function exportedName(specifier) {
  return specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value;
}

export const contractExportsAllowlist = createRule({
  name: 'contract-exports-allowlist',
  meta: {
    type: 'problem',
    docs: {
      description:
        "B2: a module's contract file may export only types/interfaces, createToken() calls, exactly one " +
        'moduleRef() call, and event type declarations — all verified to come from the kernel import, not a ' +
        'same-named local. Any other value export is rejected; zero or two-or-more moduleRef() calls are too.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          kernelPackage: { type: 'string' },
          contractGlob: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      disallowedValueExport:
        "Contract files may only export types, createToken()/moduleRef() calls imported from '{{kernelPackage}}', " +
        "and event type declarations (spec §4, B2). '{{name}}' is exported as a plain value. If this is meant to " +
        `be the module ref or a token, import moduleRef/createToken from '{{kernelPackage}}' — a locally defined ` +
        'function or constant with the same name is not recognized.',
      disallowedDefaultExport:
        '`export default` is not allowed in contract files (spec §4, B2, and AGENTS.md §8: no default exports ' +
        'anywhere in this codebase). Use a named export instead.',
      disallowedExportAll:
        "`export * from '...'` is not allowed in contract files (spec §4, B2) — its exports cannot be checked " +
        'against the allowlist. Re-export each type explicitly instead, e.g. `export type { Foo } from \'...\'`.',
      missingModuleRef:
        'This contract file never calls moduleRef() (spec §5.1, M1). Every module contract must export exactly ' +
        `one module ref: \`export const XModule = moduleRef('x')\`, with moduleRef imported from '{{kernelPackage}}'.`,
      duplicateModuleRef:
        'A contract file may declare exactly one moduleRef() call (spec §5.1, M1) — this is a second one in the ' +
        'same file. Remove it, or move it to the contract of the module it actually identifies.',
    },
  },
  defaultOptions: /** @type {[Options]} */ ([
    { kernelPackage: DEFAULT_KERNEL_PACKAGE, contractGlob: DEFAULT_CONTRACT_GLOB },
  ]),
  create(context, [options]) {
    const kernelPackage = options.kernelPackage ?? DEFAULT_KERNEL_PACKAGE;
    const contractGlob = options.contractGlob ?? DEFAULT_CONTRACT_GLOB;

    if (!matchesAnyGlob(context.filename, contractGlob)) {
      return {};
    }

    return {
      Program(program) {
        const imported = collectKernelImportNames(program.body, kernelPackage, ['moduleRef', 'createToken']);
        const moduleRefNames = /** @type {Set<string>} */ (imported.get('moduleRef'));
        const createTokenNames = /** @type {Set<string>} */ (imported.get('createToken'));

        /** @type {Map<string, LocalKind>} */
        const localKind = new Map();
        /** @type {import('@typescript-eslint/utils').TSESTree.Node[]} */
        const moduleRefCallNodes = [];

        /** @param {import('@typescript-eslint/utils').TSESTree.VariableDeclarator} decl */
        function classifyDeclarator(decl) {
          if (decl.id.type !== 'Identifier') {
            return;
          }
          /** @type {LocalKind} */
          let kind = 'other';
          if (verifiedCallName(decl.init, moduleRefNames)) {
            kind = 'moduleRef';
          } else if (verifiedCallName(decl.init, createTokenNames)) {
            kind = 'createToken';
          }
          localKind.set(decl.id.name, kind);
          if (kind === 'moduleRef') {
            const call = unwrap(decl.init);
            if (call) {
              moduleRefCallNodes.push(call);
            }
          }
        }

        // Pass 1: classify every top-level binding (exported or not — a stray,
        // never-exported `moduleRef()` call is still a second module identity
        // hiding in this file, so it counts toward the exactly-one check too).
        for (const stmt of program.body) {
          if (isTypeDeclaration(stmt)) {
            localKind.set(stmt.id.name, 'type');
          } else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) {
            localKind.set(stmt.id.name, 'other');
          } else if (stmt.type === 'VariableDeclaration') {
            stmt.declarations.forEach(classifyDeclarator);
          } else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
            const decl = stmt.declaration;
            if (isTypeDeclaration(decl)) {
              localKind.set(decl.id.name, 'type');
            } else if (decl.type === 'VariableDeclaration') {
              decl.declarations.forEach(classifyDeclarator);
            } else if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) {
              localKind.set(decl.id.name, 'other');
            }
          }
        }

        // Pass 2: walk every export statement and report anything not on the allowlist.
        for (const stmt of program.body) {
          if (stmt.type === 'ExportDefaultDeclaration') {
            context.report({ node: stmt, messageId: 'disallowedDefaultExport' });
            continue;
          }
          if (stmt.type === 'ExportAllDeclaration') {
            context.report({ node: stmt, messageId: 'disallowedExportAll' });
            continue;
          }
          if (stmt.type !== 'ExportNamedDeclaration') {
            continue;
          }
          if (stmt.exportKind === 'type') {
            continue; // `export type X = ...` / `export type { X }`.
          }

          if (stmt.declaration) {
            const decl = stmt.declaration;
            if (isTypeDeclaration(decl)) {
              continue;
            }
            if (decl.type === 'VariableDeclaration') {
              for (const d of decl.declarations) {
                if (d.id.type !== 'Identifier') {
                  context.report({
                    node: d,
                    messageId: 'disallowedValueExport',
                    data: { name: '(destructured export)', kernelPackage },
                  });
                  continue;
                }
                const kind = localKind.get(d.id.name);
                if (kind === 'type' || kind === 'moduleRef' || kind === 'createToken') {
                  continue;
                }
                context.report({ node: d, messageId: 'disallowedValueExport', data: { name: d.id.name, kernelPackage } });
              }
              continue;
            }
            // FunctionDeclaration / ClassDeclaration exported directly; anything
            // else here (TSEnumDeclaration, TSModuleDeclaration, ...) has no
            // reliable `.id.name` shape, so it gets a generic label.
            const name = (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id
              ? decl.id.name
              : '(declaration)';
            context.report({ node: decl, messageId: 'disallowedValueExport', data: { name, kernelPackage } });
            continue;
          }

          // `export { a, b as c }`, optionally `export { a } from '...'`.
          for (const specifier of stmt.specifiers) {
            if (specifier.exportKind === 'type') {
              continue;
            }
            if (stmt.source) {
              // Re-exported from elsewhere: this rule only classifies bindings
              // declared in *this* file, so a value re-export from another
              // module cannot be verified as moduleRef/createToken and is
              // rejected outright — contracts should not re-export values.
              context.report({
                node: specifier,
                messageId: 'disallowedValueExport',
                data: { name: exportedName(specifier), kernelPackage },
              });
              continue;
            }
            const localName = specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value;
            const kind = localKind.get(localName);
            if (kind === 'type' || kind === 'moduleRef' || kind === 'createToken') {
              continue;
            }
            context.report({
              node: specifier,
              messageId: 'disallowedValueExport',
              data: { name: exportedName(specifier), kernelPackage },
            });
          }
        }

        if (moduleRefCallNodes.length === 0) {
          context.report({ node: program, messageId: 'missingModuleRef', data: { kernelPackage } });
        } else if (moduleRefCallNodes.length >= 2) {
          // "report the second call's location for the duplicate case" (issue #21).
          const second = /** @type {import('@typescript-eslint/utils').TSESTree.Node} */ (moduleRefCallNodes[1]);
          context.report({ node: second, messageId: 'duplicateModuleRef' });
        }
      },
    };
  },
});
