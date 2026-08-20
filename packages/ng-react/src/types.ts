// Shared public type vocabulary for the kernel. No implementations here —
// every other module imports from this file, never the reverse.

/** A module's lifecycle state, exposed via `kernel.status` / `useModule` (A2). */
export type ModuleStatus = 'registered' | 'activating' | 'ready' | 'failed' | 'disposed';

/** Whether a module activates at startup or on first trigger (section 6). */
export type LoadStrategy = 'eager' | 'lazy';

/** The three flat provider scopes — no hierarchy (C2). */
export type Scope = 'singleton' | 'module' | 'transient';

/** Implemented by anything the container can tear down on scope end (C7). */
export interface Disposable {
  dispose(): void | Promise<void>;
}

/** Returned by subscription-shaped APIs to remove the subscription. */
export type Unsubscribe = () => void;
