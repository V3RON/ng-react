import tsParser from '@typescript-eslint/parser';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { noOverrideOutsideCompositionRoot } from './no-override-outside-composition-root.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { sourceType: 'module' },
  },
});

ruleTester.run('no-override-outside-composition-root', noOverrideOutsideCompositionRoot, {
  valid: [
    {
      name: 'override: true in the composition root is allowed',
      code: "provide(HttpToken, { override: true, factory: () => fakeHttp });",
      filename: '/repo/apps/main/src/composition-root.ts',
    },
    {
      name: 'override: true in a test file is allowed',
      code: "provide(HttpToken, { override: true, factory: () => fakeHttp });",
      filename: '/repo/packages/orders/src/service.test.ts',
    },
    {
      name: 'override: true under a **/test/** directory is allowed',
      code: "provide(HttpToken, { override: true, factory: () => fakeHttp });",
      filename: '/repo/packages/orders/test/helpers.ts',
    },
    {
      name: 'provide() without override is always fine',
      code: "provide(HttpToken, { scope: 'singleton', factory: () => http });",
      filename: '/repo/packages/orders/src/providers.ts',
    },
    {
      name: 'a call named provide with a non-boolean/dynamic override value is not statically flagged',
      code: "provide(HttpToken, { override: someFlag, factory: () => http });",
      filename: '/repo/packages/orders/src/providers.ts',
    },
  ],
  invalid: [
    {
      // B3 / acceptance criterion 8: "rejects override: true inside a module package"
      name: 'acceptance criterion 8: rejects override: true inside a module package',
      code: "provide(HttpToken, { override: true, factory: () => fakeHttp });",
      filename: '/repo/packages/orders/src/providers.ts',
      errors: [{ messageId: 'overrideOutsideCompositionRoot' }],
    },
    {
      name: 'override: true nested inside a providers array is still caught',
      code: `
        export const providers = [
          provide(HttpToken, { scope: 'singleton', override: true, factory: () => http }),
        ];
      `,
      filename: '/repo/packages/orders/src/providers.ts',
      errors: [{ messageId: 'overrideOutsideCompositionRoot' }],
    },
  ],
});
