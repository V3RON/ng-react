import type { ModuleDescriptor } from '../define-module';
import type { Kernel } from '../kernel/kernel';

/**
 * The dev-only registry a bundler plugin drives to give module-level HMR to
 * an application with **no hand-written HMR code in the module file and no
 * per-module wiring in the composition root**.
 *
 * The registry maps a `ModuleDescriptor` **object** (identity, not id
 * string) to every kernel that descriptor is registered with. `createKernel`
 * populates it for every descriptor it is given, and a successful
 * `hotReplace` extends it to cover the replacement descriptor too — so the
 * *next* edit, whose accept callback closes over that replacement object,
 * still finds its kernel.
 *
 * **Why identity and not the id string.** Two kernels in one process (R4's
 * test kernels, or two independent apps) must never observe each other. An
 * id-string registry keyed `'orders' -> kernel` would let a second kernel
 * that happens to register a module with the same id silently receive the
 * first kernel's hot updates. A descriptor is a fresh object every time its
 * defining file is evaluated (`defineModule` returns a new frozen object),
 * so keying on the object itself means a lookup can only ever succeed for
 * the exact descriptor a kernel actually holds.
 *
 * **Why a `WeakMap`.** A descriptor that no kernel holds any more — the
 * module file was hot-replaced again, or the kernel that owned it was
 * disposed and dropped — should not keep the registry (and the kernels in
 * its value sets) alive forever. Nothing here ever needs to *enumerate* the
 * registry, only to look a descriptor up, so the weak reference costs
 * nothing.
 */
const registry = new WeakMap<ModuleDescriptor, Set<Kernel>>();

/**
 * Registers `descriptor` as belonging to `kernel`.
 *
 * Called by `createKernel` for every descriptor in `KernelOptions.modules`,
 * and by the kernel's own `hotReplace` after a replacement is committed —
 * never by a bundler plugin directly. A plugin's injected code calls
 * `hotReplaceModule` only.
 *
 * @internal
 */
export function registerModuleDescriptor(kernel: Kernel, descriptor: ModuleDescriptor): void {
  let kernels = registry.get(descriptor);
  if (kernels === undefined) {
    kernels = new Set();
    registry.set(descriptor, kernels);
  }
  kernels.add(kernel);
}

/** `registerModuleDescriptor` for every descriptor in one pass. @internal */
export function registerModuleDescriptors(kernel: Kernel, descriptors: Iterable<ModuleDescriptor>): void {
  for (const descriptor of descriptors) {
    registerModuleDescriptor(kernel, descriptor);
  }
}

/**
 * Applies a module-level hot update given only the **descriptor objects**
 * involved — no kernel, no `ModuleRef` import, nothing bundler- or
 * app-specific. This is the one function a bundler plugin's injected code
 * calls.
 *
 * `prevDescriptor` is the descriptor the *old* evaluation of the module file
 * closed over — which is why the injected call has to read a local variable
 * (`module`, in this repo's convention) rather than any import: only the
 * closure over the old evaluation identifies which kernel(s) this update
 * belongs to. `nextDescriptor` is whatever the *new* evaluation exports,
 * exactly as `Kernel.hotReplace`'s own parameter of the same name expects —
 * `undefined` for an update that carried no exports (a syntax error, or a
 * host whose accept callback passes no namespace).
 *
 * A no-op, returning `false`, when `prevDescriptor` is not registered with
 * any live kernel — the module was never activated through a
 * `createKernel()` call this process has seen, most commonly because this
 * is running outside `dev` (production builds should not call this at all;
 * a plugin gates injection on that) or because the kernel that owned it was
 * disposed. Returning `true` means at least one kernel's `hotReplace` was
 * invoked; the update itself is still async and can still fail, exactly as
 * a direct `kernel.hotReplace` call can — that failure reaches the error
 * sinks and `hmr.invalidate`, per `Kernel.hotReplace`'s own contract.
 *
 * @param prevDescriptor the descriptor the module's outgoing evaluation
 *   held — the identity the registry is keyed on.
 * @param nextDescriptor the module's incoming evaluation's descriptor, or
 *   `undefined` if the update carried no usable exports.
 */
export function hotReplaceModule(
  prevDescriptor: ModuleDescriptor,
  nextDescriptor?: ModuleDescriptor,
): boolean {
  const kernels = registry.get(prevDescriptor);
  if (kernels === undefined || kernels.size === 0) {
    return false;
  }
  for (const kernel of kernels) {
    void kernel.hotReplace(prevDescriptor.id, nextDescriptor);
  }
  return true;
}
