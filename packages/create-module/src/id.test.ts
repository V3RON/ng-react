// Id validation (ADR-2, spec §4/M1/C1) and the name derivations every emitted
// identifier is built from.
//
// AGENTS.md §9: error messages are asserted as exact strings, not snapshots.
// These are the strings a human sees when the generator refuses, so they are
// part of the contract.

import { describe, expect, it } from 'vitest';
import { CreateModuleError } from './errors.js';
import { toCamelCase, toPascalCase, toRefName, validateModuleId } from './id.js';

describe('validateModuleId', () => {
  it('accepts kebab-case ids', () => {
    expect(validateModuleId('orders')).toBe('orders');
    expect(validateModuleId('demo-thing')).toBe('demo-thing');
    expect(validateModuleId('a11y-tools')).toBe('a11y-tools');
  });

  it("ADR-2: rejects the reserved id 'app'", () => {
    expect(() => validateModuleId('app')).toThrow(CreateModuleError);
    expect(() => validateModuleId('app')).toThrow(
      "create-module: 'app' is a reserved module id (ADR-2). MODULE_ID resolves to 'app' for every " +
        "resolution started outside a module, and moduleRef('app') is a fatal registration error, so no " +
        'module may claim it. Name the module after its feature instead.',
    );
  });

  it('rejects non-kebab-case ids', () => {
    for (const id of ['DemoThing', 'demo_thing', 'demo--thing', '-demo', 'demo-', '1demo', 'demo thing']) {
      expect(() => validateModuleId(id)).toThrow(CreateModuleError);
    }
    expect(() => validateModuleId('DemoThing')).toThrow(
      "create-module: invalid module id 'DemoThing'. A module id must be kebab-case — a lowercase letter " +
        'followed by lowercase letters, digits and single hyphens, e.g. ' +
        "'orders' or 'demo-thing' — because it is the package name after the scope (spec §4), the string " +
        'inside moduleRef() (M1), and the prefix of every token label (C1, ADR-8).',
    );
  });

  it('names what the id was for, so a bad --depends-on entry is not mistaken for the id', () => {
    expect(() => validateModuleId('Auth', '--depends-on entry')).toThrow(
      /^create-module: invalid --depends-on entry 'Auth'\./,
    );
    expect(() => validateModuleId('app', '--depends-on entry')).toThrow(
      /^create-module: 'app' is a reserved --depends-on entry \(ADR-2\)\./,
    );
  });

  it('rejects a missing id with the usage line', () => {
    expect(() => validateModuleId(undefined)).toThrow(
      'create-module: missing module id. Usage: create-module <id> [--scope @app] [--dir packages] ' +
        '[--load lazy|eager] [--critical] [--depends-on <id>,...] [--dry-run]',
    );
    expect(() => validateModuleId('')).toThrow(CreateModuleError);
  });
});

describe('name derivations', () => {
  it('ADR-8: a ref constant is <Pascal>Module', () => {
    expect(toPascalCase('demo-thing')).toBe('DemoThing');
    expect(toCamelCase('demo-thing')).toBe('demoThing');
    expect(toRefName('demo-thing')).toBe('DemoThingModule');
    expect(toRefName('auth')).toBe('AuthModule');
  });
});
