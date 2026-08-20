import tsParser from '@typescript-eslint/parser';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { contractExportsAllowlist } from './contract-exports-allowlist.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { sourceType: 'module' },
  },
});

const CONTRACT_FILE = '/repo/packages/orders/src/contract.ts';

ruleTester.run('contract-exports-allowlist', contractExportsAllowlist, {
  valid: [
    {
      name: 'B2: a well-formed contract — types, one moduleRef, createToken calls — is allowed',
      code: `
        import { moduleRef, createToken } from '@ng-react/kernel';

        export interface OrderService {
          place(): Promise<void>;
        }

        export const OrdersModule = moduleRef('orders');
        export const OrderServiceToken = createToken<OrderService>('orders/OrderService');

        export type OrderPlacedEvent = { orderId: string };
        export type { OrderService as OrderServiceAlias };
      `,
      filename: CONTRACT_FILE,
    },
    {
      name: 'a value export beyond the allowlist in a file that is not a contract (glob does not match) is ignored',
      code: `export const helper = () => 42;`,
      filename: '/repo/packages/orders/src/service.ts',
    },
    {
      name: 'a custom kernelPackage option is honored',
      code: `
        import { moduleRef } from '@app/kernel';
        export const OrdersModule = moduleRef('orders');
      `,
      filename: CONTRACT_FILE,
      options: [{ kernelPackage: '@app/kernel' }],
    },
    {
      name: 'a custom contractGlob option is honored',
      code: `
        import { moduleRef } from '@ng-react/kernel';
        export const OrdersModule = moduleRef('orders');
      `,
      filename: '/repo/packages/orders/src/public-api.ts',
      options: [{ contractGlob: ['**/public-api.ts'] }],
    },
  ],
  invalid: [
    {
      // B2 / acceptance criterion 8: "rejects a value export from a contract beyond the allowlist"
      name: 'acceptance criterion 8: rejects a non-allowlisted value export',
      code: `
        import { moduleRef } from '@ng-react/kernel';

        export const OrdersModule = moduleRef('orders');
        export const helper = () => 42;
      `,
      filename: CONTRACT_FILE,
      errors: [{ messageId: 'disallowedValueExport', data: { name: 'helper', kernelPackage: '@ng-react/kernel' } }],
    },
    {
      name: 'a locally defined function named createToken is not recognized as the kernel one',
      code: `
        import { moduleRef } from '@ng-react/kernel';

        function createToken(label: string) {
          return { label };
        }

        export const OrdersModule = moduleRef('orders');
        export const FakeToken = createToken('not/real');
      `,
      filename: CONTRACT_FILE,
      errors: [{ messageId: 'disallowedValueExport', data: { name: 'FakeToken', kernelPackage: '@ng-react/kernel' } }],
    },
    {
      name: 'a contract with zero moduleRef() calls is rejected',
      code: `
        import { createToken } from '@ng-react/kernel';
        export const OrderServiceToken = createToken<string>('orders/OrderService');
      `,
      filename: CONTRACT_FILE,
      errors: [{ messageId: 'missingModuleRef' }],
    },
    {
      name: 'a contract with two moduleRef() calls is rejected, pointing at the second one',
      code: `
        import { moduleRef } from '@ng-react/kernel';
        export const OrdersModule = moduleRef('orders');
        export const PaymentsModule = moduleRef('payments');
      `,
      filename: CONTRACT_FILE,
      errors: [{ messageId: 'duplicateModuleRef', line: 4 }],
    },
    {
      name: '`export default` is rejected',
      code: `
        import { moduleRef } from '@ng-react/kernel';
        export const OrdersModule = moduleRef('orders');
        export default OrdersModule;
      `,
      filename: CONTRACT_FILE,
      errors: [{ messageId: 'disallowedDefaultExport' }],
    },
    {
      name: '`export * from ...` is rejected',
      code: `
        import { moduleRef } from '@ng-react/kernel';
        export const OrdersModule = moduleRef('orders');
        export * from './extra-types';
      `,
      filename: CONTRACT_FILE,
      errors: [{ messageId: 'disallowedExportAll' }],
    },
    {
      name: 're-exporting a value from another module is rejected (cannot be verified as moduleRef/createToken)',
      code: `
        import { moduleRef } from '@ng-react/kernel';
        export const OrdersModule = moduleRef('orders');
        export { helper } from './internal';
      `,
      filename: CONTRACT_FILE,
      errors: [{ messageId: 'disallowedValueExport', data: { name: 'helper', kernelPackage: '@ng-react/kernel' } }],
    },
  ],
});
