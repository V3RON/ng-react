// The application entry point.
//
// **Not the composition root.** `composition-root.ts` is, and it is the only
// file allowed to import `<pkg>/module` (**B1**) — the lint preset's
// `compositionRoot` glob is pointed at that path alone, so an
// `import … from '@app/auth/module'` here would be rejected exactly as it
// would be in a component. This file's whole job is to build one runtime and
// mount it under a single `<AppKernel>` (**R1**).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppKernel } from '@ng-react/kernel';
import { App } from './App';
import { createAppKernel } from './composition-root';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root not found');

// `import.meta.hot` is read inside `createAppKernel`'s default parameter, and
// inside each module's own `acceptHotUpdate` — never here.
const { kernel, log } = createAppKernel();

createRoot(container).render(
  <StrictMode>
    <AppKernel kernel={kernel}>
      <App log={log} />
    </AppKernel>
  </StrictMode>,
);
