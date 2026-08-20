// Shared helper for verifying that a name used in source (`moduleRef`,
// `createToken`, ...) actually came from an `import ... from '<kernelPackage>'`
// statement in the same file, rather than being coincidentally named the
// same as a local function/variable. Used by `contract-exports-allowlist`
// (issue #21: "require them to come from the kernel package import — an
// unrelated local function named createToken must not pass").

/** @param {import('@typescript-eslint/utils').TSESTree.ImportSpecifier['imported']} imported */
function importedName(imported) {
  return imported.type === 'Identifier' ? imported.name : imported.value;
}

/**
 * Scans the top-level statements of a `Program` for
 * `import { <trackedName> as <local> } from kernelPackage` and returns, for
 * each name in `trackedNames`, the set of local identifiers it was imported
 * as (usually zero or one, but `import { moduleRef, moduleRef as ref }`
 * is legal JS so this is a set, not a single name).
 *
 * @param {readonly import('@typescript-eslint/utils').TSESTree.ProgramStatement[]} programBody
 * @param {string} kernelPackage
 * @param {readonly string[]} trackedNames
 * @returns {Map<string, Set<string>>}
 */
export function collectKernelImportNames(programBody, kernelPackage, trackedNames) {
  const result = new Map(trackedNames.map((name) => [name, new Set()]));
  for (const stmt of programBody) {
    if (stmt.type !== 'ImportDeclaration' || stmt.source.value !== kernelPackage) {
      continue;
    }
    for (const specifier of stmt.specifiers) {
      if (specifier.type !== 'ImportSpecifier') {
        continue;
      }
      const name = importedName(specifier.imported);
      const bucket = result.get(name);
      if (bucket) {
        bucket.add(specifier.local.name);
      }
    }
  }
  return result;
}
