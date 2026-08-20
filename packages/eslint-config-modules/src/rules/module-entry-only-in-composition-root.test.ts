import tsParser from '@typescript-eslint/parser';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { moduleEntryOnlyInCompositionRoot } from './module-entry-only-in-composition-root.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { sourceType: 'module' },
  },
});

ruleTester.run('module-entry-only-in-composition-root', moduleEntryOnlyInCompositionRoot, {
  valid: [
    {
      name: 'B1: /module import from the default composition-root.ts glob is allowed',
      code: "import { module } from '@app/orders/module';",
      filename: '/repo/apps/main/src/composition-root.ts',
    },
    {
      name: 'B1: /module import from main.tsx is allowed',
      code: "import { module } from '@app/orders/module';",
      filename: '/repo/apps/main/src/main.tsx',
    },
    {
      name: '/contract import is never restricted by this rule, anywhere',
      code: "import { OrdersModule } from '@app/orders/contract';",
      filename: '/repo/packages/payments/src/module.ts',
    },
    {
      name: 'a custom compositionRoot glob is honored',
      code: "import { module } from '@app/orders/module';",
      filename: '/repo/apps/main/src/bootstrap.ts',
      options: [{ compositionRoot: ['**/bootstrap.ts'] }],
    },
  ],
  invalid: [
    {
      // B1 / spec §4: "`./module` may be imported only by the application's composition root."
      name: 'importing /module outside the composition root is rejected',
      code: "import { module } from '@app/orders/module';",
      filename: '/repo/packages/payments/src/module.ts',
      errors: [{ messageId: 'moduleEntryOutsideCompositionRoot' }],
    },
    {
      name: 're-exporting /module outside the composition root is rejected too',
      code: "export { module } from '@app/orders/module';",
      filename: '/repo/packages/payments/src/module.ts',
      errors: [{ messageId: 'moduleEntryOutsideCompositionRoot' }],
    },
  ],
});
