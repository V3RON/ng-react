// `metro-runtime` ships no types for this subpath — it is a raw polyfill
// script with side effects only (installs `global.__d`/`__r`/`__accept`),
// not a module with an API surface to type. `hmr-runtime.test.ts` imports it
// for those side effects alone.
declare module 'metro-runtime/polyfills/require';
