// **H5 / R2 / ADR-2** — how a React resolution is attributed in the
// resolution graph.
//
// `.test.tsx` → the **kernel-dom** project (jsdom + the React plugin), under
// `<StrictMode>` like the rest of `src/react/`. This is the one part of H5
// that genuinely needs a renderer: `useService`'s resolution context comes
// from the nearest enclosing `<ModuleScope>`, and there is no way to produce
// that from a node test.
//
// The claim: a `useService` **inside** a `<ModuleScope>` records an edge
// attributed to that module — so editing the provider's module re-activates
// the consuming one — while a `useService` **outside** every `<ModuleScope>`
// records ADR-2's `'app'`, which is real data and is never cascaded. The
// cascade half is asserted in `src/kernel/resolution-cascade.test.ts`; what
// is proved here is the attribution that feeds it.

import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AppKernel, ModuleScope } from './context';
import { useService } from './hooks';
import { defineModule } from '../define-module';
import { createKernel } from '../kernel/kernel';
import type { Kernel } from '../kernel/kernel';
import { moduleRef } from '../module-ref';
import { provide } from '../provider';
import { createToken } from '../token';

interface PricingPolicy {
  readonly currency: string;
  quote(amountMinor: number): string;
}
const PricingPolicyToken = createToken<PricingPolicy>('pricing/PricingPolicy');

const pricingRef = moduleRef('pricing');
const storefrontRef = moduleRef('storefront');

const pricingModule = defineModule({
  id: pricingRef,
  load: 'eager',
  critical: true,
  providers: () => [
    provide(PricingPolicyToken, {
      factory: (): PricingPolicy => ({
        currency: 'EUR',
        quote: (amountMinor) => `${(amountMinor / 100).toFixed(2)} EUR`,
      }),
    }),
  ],
});

/** A module with no providers of its own — it exists to be a `<ModuleScope>`. */
const storefrontModule = defineModule({
  id: storefrontRef,
  load: 'eager',
  critical: true,
  dependsOn: [pricingRef],
});

function PriceTag(): ReactNode {
  const policy = useService(PricingPolicyToken);
  return <span>{policy.quote(2599)}</span>;
}

async function bootKernel(): Promise<Kernel> {
  const kernel = createKernel({ modules: [pricingModule, storefrontModule] });
  await kernel.whenStartupComplete();
  return kernel;
}

describe('H5 — React resolution attribution', () => {
  it('H5/R2: a useService inside a <ModuleScope> records an edge attributed to that module', async () => {
    const kernel = await bootKernel();

    render(
      <StrictMode>
        <AppKernel kernel={kernel}>
          <ModuleScope module={storefrontRef}>
            <PriceTag />
          </ModuleScope>
        </AppKernel>
      </StrictMode>,
    );

    expect(kernel.inspect().resolutionGraph).toEqual([
      { consumer: 'storefront', owner: 'pricing', token: 'pricing/PricingPolicy' },
    ]);
  });

  it("H5/ADR-2: a useService outside every <ModuleScope> records an 'app'-attributed edge", async () => {
    const kernel = await bootKernel();

    render(
      <StrictMode>
        <AppKernel kernel={kernel}>
          <PriceTag />
        </AppKernel>
      </StrictMode>,
    );

    // Recorded, and honestly so — the composition root really is holding a
    // `pricing` instance. It is simply not a module: `'app'` has no
    // descriptor to re-evaluate and no context to dispose, so H6's epoch
    // bump (which this component already subscribes to) is what refreshes
    // it, not a cascade entry.
    expect(kernel.inspect().resolutionGraph).toEqual([
      { consumer: 'app', owner: 'pricing', token: 'pricing/PricingPolicy' },
    ]);
  });

  it('H5: the two attributions coexist, and the graph stays deterministically sorted (G3)', async () => {
    const kernel = await bootKernel();

    render(
      <StrictMode>
        <AppKernel kernel={kernel}>
          <ModuleScope module={storefrontRef}>
            <PriceTag />
          </ModuleScope>
          <PriceTag />
        </AppKernel>
      </StrictMode>,
    );

    // Sorted by consumer, so `'app'` comes first regardless of which subtree
    // React committed first — the property G3 exists to give snapshot tests.
    expect(kernel.inspect().resolutionGraph).toEqual([
      { consumer: 'app', owner: 'pricing', token: 'pricing/PricingPolicy' },
      { consumer: 'storefront', owner: 'pricing', token: 'pricing/PricingPolicy' },
    ]);
  });
});
