import { describe, expect, it } from 'vitest';
import preset from './index.js';

const RULE_NAMES = [
  'no-cross-module-deep-import',
  'module-entry-only-in-composition-root',
  'contract-exports-allowlist',
  'no-override-outside-composition-root',
  'no-transient-in-component',
];

/** Narrows an optional value to defined, failing the test with `label` if it isn't. */
function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

describe('@ng-react/eslint-config-modules preset shape', () => {
  it('exports all five B1-B3 rules on the top-level `rules` map', () => {
    for (const name of RULE_NAMES) {
      const rule = must(preset.rules[name], `preset.rules['${name}']`);
      expect(typeof rule.create).toBe('function');
    }
  });

  it('configs.recommended registers the plugin and every rule as error, except the R2 heuristic', () => {
    const config = must(preset.configs.recommended[0], 'configs.recommended[0]');
    const plugins = must(config.plugins, 'config.plugins');
    const configRules = must(config.rules, 'config.rules');
    expect(must(plugins['ng-react-modules'], "plugins['ng-react-modules']").rules).toBe(preset.rules);
    expect(configRules['ng-react-modules/no-cross-module-deep-import']).toBe('error');
    expect(configRules['ng-react-modules/module-entry-only-in-composition-root']).toBe('error');
    expect(configRules['ng-react-modules/contract-exports-allowlist']).toBe('error');
    expect(configRules['ng-react-modules/no-override-outside-composition-root']).toBe('error');
    expect(configRules['ng-react-modules/no-transient-in-component']).toBe('warn');
  });

  it('B3: configs.recommended wires up import-x/no-cycle across the workspace', () => {
    const config = must(preset.configs.recommended[0], 'configs.recommended[0]');
    const plugins = must(config.plugins, 'config.plugins');
    const configRules = must(config.rules, 'config.rules');
    const importX = must(plugins['import-x'], "plugins['import-x']");
    expect(must(importX.rules, 'importX.rules')['no-cycle']).toBeDefined();
    expect(configRules['import-x/no-cycle']).toBe('error');
    expect(configRules['import-x/no-unresolved']).toBe('error');

    // Issue #43: both of these are prerequisites for `no-cycle` to report
    // anything at all in a TypeScript workspace, and both fail *silently* when
    // absent. `src/no-cycle.test.ts` is what proves they work; this only pins
    // that they are still declared.
    const settings = must(config.settings, 'config.settings');
    expect(settings['import-x/resolver-next']).toHaveLength(1);
    expect(settings['import-x/extensions']).toContain('.ts');
    expect(settings['import-x/extensions']).toContain('.tsx');
  });

  it('configs.strict escalates the R2 heuristic to error and leaves the rest unchanged', () => {
    const recommended = must(must(preset.configs.recommended[0], 'configs.recommended[0]').rules, 'recommended.rules');
    const strict = must(must(preset.configs.strict[0], 'configs.strict[0]').rules, 'strict.rules');
    expect(strict['ng-react-modules/no-transient-in-component']).toBe('error');
    expect(strict['ng-react-modules/no-cross-module-deep-import']).toBe(
      recommended['ng-react-modules/no-cross-module-deep-import'],
    );
  });

  it('both config tiers apply only to .ts/.tsx files', () => {
    for (const config of [...preset.configs.recommended, ...preset.configs.strict]) {
      expect(config.files).toEqual(['**/*.ts', '**/*.tsx']);
    }
  });
});
