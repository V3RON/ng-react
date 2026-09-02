#!/usr/bin/env node
// End-to-end proof that `@ng-react/vite-plugin` gives ng-react modules
// module-level HMR out of the box, against a **real** `vite` dev server and
// a **real** browser (Chromium via `playwright-core`) — not a simulation of
// either.
//
// Run: `pnpm --filter @ng-react/demo-react hmr-e2e` (from the repo root), or
// `node apps/react/scripts/hmr-e2e.mjs` from `apps/react/`.
//
// What each scenario does, uniformly:
//   1. record a baseline from the live DOM,
//   2. edit a real file on disk with `fs.writeFileSync`,
//   3. poll the DOM for the edit's expected effect,
//   4. assert the `window` marker set at boot is still there (no full
//      reload happened) and that the persistent notes store's *count*
//      survived (H3/H4),
//   5. restore the file to the exact bytes it held before this script ran.
//
// **Restoration is from an in-memory snapshot taken at start, not `git
// checkout --`.** The working tree touched by this script can legitimately
// have uncommitted changes of its own (this script is meant to run against
// exactly such a tree) — `git checkout --` would silently discard those
// back to HEAD instead of restoring "what was here a moment ago", which is
// a real failure mode this script hit once and must not repeat.
//
// Every scenario's PASS/FAIL and the relevant `[vite]` console lines are
// printed at the end. A non-zero exit code means at least one scenario
// failed.

import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '../..');
const PORT = Number(process.env.HMR_E2E_PORT ?? 5183);
const BASE_URL = `http://localhost:${String(PORT)}/`;

/** Files this script edits and restores. Absolute paths, resolved once. */
const FILES = {
  providers: path.join(REPO_ROOT, 'packages/orders/src/providers.ts'),
  lifecycle: path.join(REPO_ROOT, 'packages/orders/src/lifecycle.ts'),
  module: path.join(REPO_ROOT, 'packages/orders/src/module.ts'),
  shell: path.join(REPO_ROOT, 'apps/react/src/App.tsx'),
};

/** The exact bytes each file in `FILES` held when this script started. */
const originalContents = new Map(
  Object.values(FILES).map((absolute) => [absolute, fs.readFileSync(absolute, 'utf8')]),
);

/** Results accumulated across the run, printed as a table at the end. */
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`\n[${tag}] ${name}`);
  if (detail) console.log(`       ${detail}`);
}

/** Restores one file to its pre-script snapshot. Idempotent. */
function restoreFile(absolutePath) {
  const original = originalContents.get(absolutePath);
  if (original === undefined) {
    throw new Error(`no snapshot recorded for ${absolutePath}`);
  }
  fs.writeFileSync(absolutePath, original);
}

/** Restores every file this script may have touched. Idempotent — a clean tree is a no-op. */
function restoreAllFiles() {
  for (const absolute of originalContents.keys()) {
    restoreFile(absolute);
  }
}

/** Finds a real Chromium binary. `playwright-core`'s own expected revision may not
 * match what's actually installed under `PLAYWRIGHT_BROWSERS_PATH` — fall back to it. */
function findChromiumExecutable() {
  const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersDir && fs.existsSync(browsersDir)) {
    const candidates = fs
      .readdirSync(browsersDir)
      .filter((name) => name.startsWith('chromium-') && !name.includes('headless_shell'))
      .sort()
      .reverse();
    for (const candidate of candidates) {
      const exe = path.join(browsersDir, candidate, 'chrome-linux', 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

/** Starts the real `vite` dev server for `apps/react` and waits for it to answer. */
async function startVite() {
  const { spawn } = await import('node:child_process');
  const child = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: APP_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    out += String(chunk);
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE_URL);
      if (res.ok) return { child, getOutput: () => out };
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  console.error('vite dev server output so far:\n' + out);
  throw new Error(`vite dev server did not become ready on ${BASE_URL} within 30s`);
}

/** Polls `fn` until it returns a truthy value or the timeout elapses. */
async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for: ${label}${lastError ? ` (last error: ${String(lastError)})` : ''}`);
    }
    await sleep(intervalMs);
  }
}

async function main() {
  restoreAllFiles();

  console.log(`Starting vite dev server on ${BASE_URL} ...`);
  const vite = await startVite();
  console.log('vite is up.');

  const executablePath = findChromiumExecutable();
  console.log(`Launching Chromium${executablePath ? ` (${executablePath})` : ' (playwright-core default)'} ...`);
  const browser = await chromium.launch({ headless: true, executablePath });

  const consoleLines = [];
  let overallOk = true;

  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      consoleLines.push(msg.text());
    });
    page.on('pageerror', (err) => {
      consoleLines.push(`[pageerror] ${String(err)}`);
    });

    await page.goto(BASE_URL, { waitUntil: 'load' });
    await page.waitForSelector('h1:has-text("acceptance criterion 1")', { timeout: 15_000 });

    // The marker: a plain `window` property, set directly (not through
    // React), so its survival is a fact about the *page*, not about any
    // component's state. A full reload replaces `window` entirely.
    await page.evaluate(() => {
      window.__ngReactE2EMarker = 'set-by-hmr-e2e';
    });

    async function markerSurvived() {
      return page.evaluate(() => window.__ngReactE2EMarker === 'set-by-hmr-e2e');
    }

    // --- Activate orders, then navigate to its own route -------------------
    // `orders` is `lazy`: its `MenuEntryToken`/`RouteConfigToken`
    // contributions (and so the menu item and the nav route) do not exist
    // until it activates (C5). `App.tsx`'s own "Activate orders" button is
    // `kernel.activate(OrdersModule)` directly — the simplest way to get
    // there without depending on the menu having a row that isn't there yet.
    await page.click('text=Activate orders');
    await page.waitForSelector('[data-testid="module-orders"][data-status="ready"]', { timeout: 15_000 });
    console.log('orders module is ready.');

    // Now the menu has an "orders/detail" row; open it and navigate to
    // orders' own screen (contributed by `orders/providers.ts`, not the
    // shell's `OrdersSection`).
    await page.click('[data-testid="app-menu-toggle"]');
    await page.click('[data-testid="menu-item-orders/detail"]');
    await page.waitForSelector('[data-testid="orders-screen"]', { timeout: 15_000 });
    console.log('orders screen is rendered.');

    // A baseline order, so a *reset* of this count is observable evidence
    // that a module.ts edit really did dispose+reactivate orders.
    await page.click('text=Place a 25.00 EUR order');
    await waitFor(() => page.locator('[data-testid="orders-placed"]').textContent().then((t) => t?.includes('1 order')), {
      label: '"1 order(s) placed" after clicking the button',
    });

    // **Why the expected note count is the literal `'1'`, not a baseline
    // read off the DOM before any edit.** `ContributionPanel` subscribes to
    // the C5 collection (`useServiceAll(DiagnosticPanelToken)`), which only
    // re-renders it when a contribution is *added or removed* — never when
    // the underlying service's own state changes. `orders`' row is added the
    // moment its providers register, which is *before* `lifecycle.ts`'s
    // `init` seeds the persistent notes store (D1's own ordering), so a
    // "baseline" read here would race that seed and can legitimately observe
    // a stale `0 note(s) held` from the add notification that fired first —
    // which is exactly what this script measured on its first run. The seed
    // is guarded (`if (notes.getState().length === 0)`), so once it has run
    // even once, the store never grows or resets again short of a real
    // `kernel.deactivate()` (which this script never calls) — so `'1'` is
    // the one correct expectation for every scenario below, including the
    // very first.
    const EXPECTED_NOTE_COUNT = '1';

    // =======================================================================
    // Scenario 1 — edit packages/orders/src/providers.ts
    // =======================================================================
    try {
      const before = fs.readFileSync(FILES.providers, 'utf8');
      if (!before.includes("label: 'Orders',")) {
        throw new Error("providers.ts no longer contains \"label: 'Orders',\" — update this script's edit.");
      }
      const consoleBefore = consoleLines.length;
      fs.writeFileSync(FILES.providers, before.replace("label: 'Orders',", "label: 'Orders (edited)',"));

      await waitFor(
        () => page.locator('[data-testid="panel-orders"]').textContent().then((t) => t?.includes('Orders (edited)')),
        { label: 'panel-orders to show the edited label', timeoutMs: 20_000 },
      );
      const survivedMarker = await markerSurvived();
      const panelTextAfter = await page.locator('[data-testid="panel-orders"]').textContent();
      const noteCountAfter = /(\d+) note\(s\) held/.exec(panelTextAfter ?? '')?.[1];
      const hmrLines = consoleLines.slice(consoleBefore).filter((l) => l.includes('[vite]'));
      const sawHotUpdate = hmrLines.some((l) => l.includes('hot updated'));

      const pass = survivedMarker && noteCountAfter === EXPECTED_NOTE_COUNT && sawHotUpdate;
      record(
        'providers.ts edit: label change renders, marker + persistent notes survive, [vite] hot updated logged',
        pass,
        `marker=${String(survivedMarker)} noteCount (expected ${EXPECTED_NOTE_COUNT}) -> ${String(noteCountAfter)} ` +
          `console=[${hmrLines.join(' | ')}]`,
      );
      overallOk &&= pass;
    } finally {
      restoreFile(FILES.providers);
      // Let the revert's own HMR settle before the next scenario.
      await sleep(1000);
    }

    // =======================================================================
    // Scenario 2 — edit packages/orders/src/lifecycle.ts
    // =======================================================================
    try {
      const before = fs.readFileSync(FILES.lifecycle, 'utf8');
      const anchor = '  ctx.effect(() => {';
      if (!before.includes(anchor)) {
        throw new Error('lifecycle.ts no longer contains the expected ctx.effect( anchor — update this script.');
      }
      const baselineText = await page.locator('[data-testid="orders-session-changes"]').textContent();
      const baselineSessionChanges = Number(/(\d+) session/.exec(baselineText ?? '')?.[1]);
      if (Number.isNaN(baselineSessionChanges)) {
        throw new Error(`could not read baseline session-changes count from: ${String(baselineText)}`);
      }

      const consoleBefore = consoleLines.length;
      // One extra, unconditional call at the top of `init` — a real,
      // user-visible-in-the-DOM behavioural edit to this exact file, not a
      // comment-only change.
      fs.writeFileSync(
        FILES.lifecycle,
        before.replace(
          anchor,
          '  // hmr-e2e: one extra bump, added by this edit, to prove lifecycle.ts re-ran.\n  service.noteSessionChange();\n' +
            anchor,
        ),
      );

      await waitFor(
        () =>
          page
            .locator('[data-testid="orders-session-changes"]')
            .textContent()
            .then((t) => Number(/(\d+) session/.exec(t ?? '')?.[1]) === baselineSessionChanges + 1),
        { label: 'session-changes count to increment by exactly 1', timeoutMs: 20_000 },
      );
      const survivedMarker = await markerSurvived();
      const panelTextAfter = await page.locator('[data-testid="panel-orders"]').textContent();
      const noteCountAfter = /(\d+) note\(s\) held/.exec(panelTextAfter ?? '')?.[1];
      const hmrLines = consoleLines.slice(consoleBefore).filter((l) => l.includes('[vite]'));
      const sawHotUpdate = hmrLines.some((l) => l.includes('hot updated'));

      const pass = survivedMarker && noteCountAfter === EXPECTED_NOTE_COUNT && sawHotUpdate;
      record(
        'lifecycle.ts edit: init-time behaviour change applies, marker + persistent notes survive, [vite] hot updated logged',
        pass,
        `marker=${String(survivedMarker)} noteCount (expected ${EXPECTED_NOTE_COUNT}) -> ${String(noteCountAfter)} ` +
          `console=[${hmrLines.join(' | ')}]`,
      );
      overallOk &&= pass;
    } finally {
      restoreFile(FILES.lifecycle);
      await sleep(1000);
    }

    // =======================================================================
    // Scenario 3 — edit packages/orders/src/module.ts itself
    // =======================================================================
    try {
      // A fresh baseline order count, since the two edits above already
      // disposed+reactivated `orders` at least once each (H4: singleton
      // instances, `orders-placed` included, are discarded on every hot
      // update — only the `persistent: true` notes store is carried over).
      await page.click('text=Place a 25.00 EUR order');
      await waitFor(
        () => page.locator('[data-testid="orders-placed"]').textContent().then((t) => t?.includes('1 order')),
        { label: '"1 order(s) placed" baseline before the module.ts edit' },
      );

      const before = fs.readFileSync(FILES.module, 'utf8');
      const anchor = 'dependsOn: [AuthModule, PaymentsModule],';
      if (!before.includes(anchor)) {
        throw new Error('module.ts no longer contains the expected dependsOn line — update this script.');
      }
      const consoleBefore = consoleLines.length;
      // Reordering `dependsOn` is a structurally real edit — a fresh
      // descriptor object — with no behavioural effect of its own (the
      // kernel topologically sorts it either way), which is what makes the
      // `orders-placed` reset below attributable to the hot-replace cascade
      // itself rather than to any change in what the descriptor declares.
      fs.writeFileSync(FILES.module, before.replace(anchor, 'dependsOn: [PaymentsModule, AuthModule],'));

      await waitFor(
        () => page.locator('[data-testid="orders-placed"]').textContent().then((t) => t?.includes('0 order')),
        { label: '"0 order(s) placed" after the module.ts edit re-activates orders', timeoutMs: 20_000 },
      );
      const survivedMarker = await markerSurvived();
      const panelTextAfter = await page.locator('[data-testid="panel-orders"]').textContent();
      const noteCountAfter = /(\d+) note\(s\) held/.exec(panelTextAfter ?? '')?.[1];
      const hmrLines = consoleLines.slice(consoleBefore).filter((l) => l.includes('[vite]'));
      const sawHotUpdate = hmrLines.some((l) => l.includes('hot updated'));

      const pass = survivedMarker && noteCountAfter === EXPECTED_NOTE_COUNT && sawHotUpdate;
      record(
        'module.ts edit: fresh descriptor drives a real re-activation (orders-placed resets), marker + persistent notes survive, [vite] hot updated logged',
        pass,
        `marker=${String(survivedMarker)} noteCount (expected ${EXPECTED_NOTE_COUNT}) -> ${String(noteCountAfter)} ` +
          `console=[${hmrLines.join(' | ')}]`,
      );
      overallOk &&= pass;
    } finally {
      restoreFile(FILES.module);
      await sleep(1000);
    }

    // =======================================================================
    // Negative control — a non-ng-react-module file still hot-updates via
    // ordinary React Fast Refresh, with no reload and no involvement of
    // `@ng-react/vite-plugin` (it does not match the module-entry heuristic).
    // =======================================================================
    try {
      const before = fs.readFileSync(FILES.shell, 'utf8');
      const anchor = 'ng-react kernel — acceptance criterion 1';
      if (!before.includes(anchor)) {
        throw new Error('App.tsx no longer contains the expected heading text — update this script.');
      }
      const consoleBefore = consoleLines.length;
      fs.writeFileSync(FILES.shell, before.replace(anchor, `${anchor} (fast refresh edit)`));

      await page.waitForSelector('h1:has-text("(fast refresh edit)")', { timeout: 20_000 });
      const survivedMarker = await markerSurvived();
      // Still on the orders screen — Fast Refresh preserves component state
      // (React's own guarantee), which a full reload would not.
      const stillOnOrders = await page.locator('[data-testid="orders-screen"]').isVisible();
      const hmrLines = consoleLines.slice(consoleBefore).filter((l) => l.includes('[vite]'));

      const pass = survivedMarker && stillOnOrders;
      record(
        'negative control: editing App.tsx (not an ng-react module) hot-updates via React Fast Refresh, no reload',
        pass,
        `marker=${String(survivedMarker)} stillOnOrdersScreen=${String(stillOnOrders)} console=[${hmrLines.join(' | ')}]`,
      );
      overallOk &&= pass;
    } finally {
      restoreFile(FILES.shell);
    }
  } finally {
    await browser.close();
    vite.child.kill();
    restoreAllFiles();
  }

  console.log('\n=== Captured [vite] console lines (full log) ===');
  for (const line of consoleLines.filter((l) => l.includes('[vite]'))) {
    console.log(' ', line);
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  }

  if (!overallOk) {
    console.error('\nAt least one scenario FAILED.');
    process.exitCode = 1;
  } else {
    console.log('\nAll scenarios PASSED.');
  }
}

main().catch((error) => {
  console.error(error);
  restoreAllFiles();
  process.exitCode = 1;
});
