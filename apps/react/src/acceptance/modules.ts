// Shared scaffolding for the acceptance suite.
//
// **Every acceptance test builds on the real descriptors**, taken from the
// application's own `appModules` export. That is not convenience: a test that
// hand-assembled a module list would go on passing while the composition root
// was wrong, and the composition root is part of what the criteria are about.
//
// It is also the only way a test *can* reach them. **B1** reserves
// `<pkg>/module` for the composition root, and the lint rule enforcing it —
// unlike `no-override-outside-composition-root` — has no test-file exemption,
// so `import { module } from '@app/orders/module'` in a test file is an error.
// The composition root re-exporting its list is the sanctioned door.

import { defineModule } from '@ng-react/kernel';
import type { ModuleDescriptor, ModuleRef } from '@ng-react/kernel';
import { appModules } from '../composition-root';

/**
 * The application's descriptor for `ref`.
 *
 * Throws when there is none, because every caller here is about to assert
 * something about a module the demo is supposed to register — and "the demo
 * stopped registering `orders`" must fail a test rather than skip one.
 */
export function descriptorFor(ref: ModuleRef): ModuleDescriptor {
  const found = appModules.find((descriptor) => descriptor.id === ref);
  if (found === undefined) {
    throw new Error(
      `The composition root does not register '${ref.id}'. The acceptance suite is written ` +
        `against the real app; adjust the suite deliberately rather than making this lookup optional.`,
    );
  }
  return found;
}

/**
 * The same descriptor with some static fields changed, and **the same thunks**.
 *
 * This is how the suite models "someone edited the composition root" — a
 * missing `dependsOn` entry (criterion 2, criterion 5), an all-lazy load
 * strategy (criterion 9) — without cloning the module's implementation. The
 * providers and `init` that run are byte-for-byte the ones the app ships, so
 * the token labels in a resulting error message are the real ones rather than
 * a test's approximation of them.
 *
 * `defineModule` re-validates, so a variant that is not a legal descriptor
 * fails here rather than at registration.
 */
export function variantOf(
  ref: ModuleRef,
  overrides: Partial<Omit<ModuleDescriptor, 'id'>>,
): ModuleDescriptor {
  return defineModule({ ...descriptorFor(ref), ...overrides });
}
