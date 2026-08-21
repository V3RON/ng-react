/**
 * Whether the bindings are running in dev mode, gating their dev-only
 * warnings.
 *
 * Read through `globalThis` because `process` may not exist in a browser or
 * under React Native.
 */
export const IS_DEV: boolean =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'NODE_ENV'
  ] !== 'production';
