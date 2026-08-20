import tsParser from '@typescript-eslint/parser';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { noTransientInComponent } from './no-transient-in-component.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { sourceType: 'module', ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run('no-transient-in-component', noTransientInComponent, {
  valid: [
    {
      name: 'useService on a singleton-scoped token (same file) does not warn',
      code: `
        provide(HttpToken, { scope: 'singleton', factory: () => http });
        function Widget() {
          const http = useService(HttpToken);
          return null;
        }
      `,
      filename: '/repo/packages/orders/src/widget.tsx',
    },
    {
      name: 'useService on a token with no local provide() at all does not warn',
      code: `
        function Widget() {
          const http = useService(HttpToken);
          return null;
        }
      `,
      filename: '/repo/packages/orders/src/widget.tsx',
    },
    {
      name: 'a transient provider for a *different* token than the one useService resolves does not warn',
      code: `
        provide(LoggerToken, { scope: 'transient', factory: () => createLogger() });
        function Widget() {
          const http = useService(HttpToken);
          return null;
        }
      `,
      filename: '/repo/packages/orders/src/widget.tsx',
    },
  ],
  invalid: [
    {
      // R2: demonstrates the rule firing on the one case it can see — a
      // transient provider and the useService() call colocated in one file.
      name: 'R2: useService on a token provided scope: transient in the same file warns',
      code: `
        export const providers = [
          provide(RequestScopedToken, { scope: 'transient', factory: () => createRequestScoped() }),
        ];

        function Widget() {
          const scoped = useService(RequestScopedToken);
          return null;
        }
      `,
      filename: '/repo/packages/orders/src/widget.tsx',
      errors: [{ messageId: 'transientInComponent', data: { token: 'RequestScopedToken' } }],
    },
    {
      name: 'fires even when the transient provider is declared after the useService() call',
      code: `
        function Widget() {
          const scoped = useService(RequestScopedToken);
          return null;
        }
        provide(RequestScopedToken, { scope: 'transient', factory: () => createRequestScoped() });
      `,
      filename: '/repo/packages/orders/src/widget.tsx',
      errors: [{ messageId: 'transientInComponent' }],
    },
  ],
});
