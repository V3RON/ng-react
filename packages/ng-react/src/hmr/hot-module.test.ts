// The dev-only descriptor->kernel registry that lets a bundler plugin give a
// module hot replacement with no hand-written HMR code in the module file
// and no per-module wiring in the composition root.
//
// `.test.ts` -> the **kernel** project (node): no bundler in the path, which
// is the point — a plugin's injected call is nothing but
// `hotReplaceModule(module, next?.module)`, and that is exactly what this
// file drives directly, the same way `kernel/hot-replace.test.ts` drives
// `kernel.hotReplace` directly.

import { describe, expect, it, vi } from 'vitest';

import { defineModule } from '../define-module';
import type { ModuleDescriptor } from '../define-module';
import { moduleRef } from '../module-ref';
import { provide } from '../provider';
import { createToken } from '../token';
import { createKernel } from '../kernel/kernel';
import type { Kernel } from '../kernel/kernel';
import { hotReplaceModule } from './hot-module';

interface Greeter {
  greet(): string;
}
const GreeterToken = createToken<Greeter>('greetings/Greeter');

/** A one-module kernel whose sole provider's value is what changes across an edit. */
function greeterModule(ref: ReturnType<typeof moduleRef>, message: string): ModuleDescriptor {
  return defineModule({
    id: ref,
    dependsOn: [],
    load: 'eager',
    critical: false,
    providers: () => [provide(GreeterToken, { factory: () => ({ greet: () => message }) })],
  });
}

describe('hotReplaceModule', () => {
  it('is a no-op returning false for a descriptor no kernel has ever registered', () => {
    const orphan = greeterModule(moduleRef('orphan'), 'hello');
    expect(hotReplaceModule(orphan)).toBe(false);
    expect(hotReplaceModule(orphan, greeterModule(orphan.id, 'goodbye'))).toBe(false);
  });

  it('createKernel registers every descriptor, and hotReplaceModule reaches the real kernel.hotReplace', async () => {
    const ref = moduleRef('greetings');
    const first = greeterModule(ref, 'hello');
    const kernel = createKernel({ modules: [first] });
    await kernel.activate(ref);
    expect(kernel.get(GreeterToken).greet()).toBe('hello');

    const second = greeterModule(ref, 'hola');
    const applied = hotReplaceModule(first, second);
    expect(applied).toBe(true);

    // `hotReplaceModule` fires `kernel.hotReplace` but does not await it —
    // exactly like a bundler's own accept callback, which is synchronous.
    // Settle on the kernel's own state rather than a timer.
    await vi.waitFor(() => {
      expect(kernel.get(GreeterToken).greet()).toBe('hola');
    });
  });

  it('chains across edits: the replacement descriptor is itself registered on success', async () => {
    const ref = moduleRef('greetings');
    const gen1 = greeterModule(ref, 'v1');
    const kernel = createKernel({ modules: [gen1] });
    await kernel.activate(ref);

    const gen2 = greeterModule(ref, 'v2');
    expect(hotReplaceModule(gen1, gen2)).toBe(true);
    await vi.waitFor(() => {
      expect(kernel.get(GreeterToken).greet()).toBe('v2');
    });

    // The *second* edit's accept callback closes over `gen2` as its
    // `prevDescriptor` — exactly as the module's own re-evaluated file
    // would. Without `commitReplacement` re-registering it, this would be
    // the "orphan" case above and silently do nothing.
    const gen3 = greeterModule(ref, 'v3');
    expect(hotReplaceModule(gen2, gen3)).toBe(true);
    await vi.waitFor(() => {
      expect(kernel.get(GreeterToken).greet()).toBe('v3');
    });

    // `gen1` is stale — no accept callback in a real bundler would ever fire
    // with it as `prevDescriptor` again, because Vite/Metro only ever call
    // through the *latest* evaluation's closure — but the registry itself
    // does not proactively evict it either (a `WeakMap` costs nothing to
    // leave alone, and there is nothing to evict *to*: the entry drops out
    // on its own once `gen1` is no longer referenced anywhere, module scope
    // included). So this still finds `kernel` and still applies.
    expect(hotReplaceModule(gen1, gen2)).toBe(true);
  });

  it('two kernels stay isolated even when their descriptors share a module id string', async () => {
    const refA = moduleRef('greetings');
    const refB = moduleRef('greetings');
    const descriptorA = greeterModule(refA, 'a1');
    const descriptorB = greeterModule(refB, 'b1');

    const kernelA = createKernel({ modules: [descriptorA] });
    const kernelB = createKernel({ modules: [descriptorB] });
    await kernelA.activate(refA);
    await kernelB.activate(refB);

    const replacedOn: Kernel[] = [];
    const originalA = kernelA.hotReplace.bind(kernelA);
    kernelA.hotReplace = async (ref, next) => {
      replacedOn.push(kernelA);
      await originalA(ref, next);
    };
    const originalB = kernelB.hotReplace.bind(kernelB);
    kernelB.hotReplace = async (ref, next) => {
      replacedOn.push(kernelB);
      await originalB(ref, next);
    };

    // `descriptorA` was only ever registered against `kernelA` — its object
    // identity is what the registry is keyed on, and `kernelB`'s own
    // `greeterModule('greetings', 'b1')` call produced a *different* object
    // even though the id string is the same.
    expect(hotReplaceModule(descriptorA, greeterModule(refA, 'a2'))).toBe(true);
    await vi.waitFor(() => {
      expect(replacedOn).toEqual([kernelA]);
    });
    expect(kernelB.get(GreeterToken).greet()).toBe('b1');
  });

  it('a production kernel (dev: false) registers nothing', async () => {
    const ref = moduleRef('greetings');
    const descriptor = greeterModule(ref, 'hello');
    const kernel = createKernel({ modules: [descriptor], dev: false });
    await kernel.activate(ref);

    expect(hotReplaceModule(descriptor, greeterModule(ref, 'goodbye'))).toBe(false);
    expect(kernel.get(GreeterToken).greet()).toBe('hello');
  });
});
