import tsParser from '@typescript-eslint/parser';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { noCrossModuleDeepImport } from './no-cross-module-deep-import.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { sourceType: 'module' },
  },
});

ruleTester.run('no-cross-module-deep-import', noCrossModuleDeepImport, {
  valid: [
    {
      name: 'B1: importing another module via its /contract subpath is allowed',
      code: "import { OrdersModule, OrderServiceToken } from '@app/orders/contract';",
      filename: '/repo/packages/payments/src/module.ts',
    },
    {
      name: "B1: importing another module's /module subpath is allowed here (location is module-entry-only-in-composition-root's job)",
      code: "import { module } from '@app/orders/module';",
      filename: '/repo/apps/main/src/composition-root.ts',
    },
    {
      name: 'ordinary relative import within the same package is allowed',
      code: "import { helper } from './helper';",
      filename: '/repo/packages/orders/src/service.ts',
    },
    {
      name: 'a relative import that is not inside a recognizable packages/apps layout is not enforced',
      code: "import { helper } from '../../shared/helper';",
      filename: '/repo/tools/script.ts',
    },
    {
      name: 'a non-module-package bare specifier (e.g. a third-party lib) is ignored',
      code: "import React from 'react';",
      filename: '/repo/packages/orders/src/service.ts',
    },
  ],
  invalid: [
    {
      // B1 / acceptance criterion 8: "rejects a deep import into another module's src/"
      name: "acceptance criterion 8: rejects a relative deep import into another module's src/",
      code: "import { internalThing } from '../../payments/src/internal';",
      filename: '/repo/packages/orders/src/service.ts',
      errors: [{ messageId: 'relativeEscape', data: { specifier: '../../payments/src/internal', targetPkg: 'payments' } }],
    },
    {
      name: 'a package-specifier import past /contract or /module is a deep import',
      code: "import { internal } from '@app/orders/lifecycle';",
      filename: '/repo/packages/payments/src/module.ts',
      errors: [
        {
          messageId: 'deepImportSpecifier',
          data: { specifier: '@app/orders/lifecycle', pkg: 'orders', suggestion: '@app/orders/contract' },
        },
      ],
    },
    {
      name: 'a nested deep import is still a deep import',
      code: "import { internal } from '@app/orders/lifecycle/handlers';",
      filename: '/repo/packages/payments/src/module.ts',
      errors: [{ messageId: 'deepImportSpecifier' }],
    },
    {
      name: 'importing a module package with no subpath (no root export, spec §4) is rejected',
      code: "import orders from '@app/orders';",
      filename: '/repo/packages/payments/src/module.ts',
      errors: [
        {
          messageId: 'bareModuleImport',
          data: { specifier: '@app/orders', pkg: 'orders', suggestion: '@app/orders/contract' },
        },
      ],
    },
    {
      name: 're-exporting via a deep import specifier is rejected too',
      code: "export { internal } from '@app/orders/lifecycle';",
      filename: '/repo/packages/payments/src/module.ts',
      errors: [{ messageId: 'deepImportSpecifier' }],
    },
    {
      name: 'a dynamic import() of a deep specifier is rejected',
      code: "const mod = () => import('@app/orders/lifecycle');",
      filename: '/repo/packages/payments/src/module.ts',
      errors: [{ messageId: 'deepImportSpecifier' }],
    },
  ],
});
