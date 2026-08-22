# Native device verification

Issue #60 was driven on an iPhone 17 Pro simulator running iOS 26.5, with
Expo SDK 57, React Native 0.86, and Metro on port 8083. The accessibility tree
was checked before every interaction; the screenshots below are paired with
the specific claim they prove.

## Drawer contributions

![Drawer with five active entries](device-verification/issue-60/01-drawer-active-modules.png)

The initial drawer contains five live entries attributed to `auth`,
`dashboard`, and the native shell. The feature-owned `orders/detail` entry is
absent because the lazy orders module has not activated yet.

## Lazy route activation

![Orders route with activation trace](device-verification/issue-60/02-orders-activation-trace.png)

Tapping the shell-owned **Orders section** route activates the lazy module and
renders its screen. The on-screen render trace records
`registered → activating → ready`; the middle render lasts only a few
milliseconds under Metro, so the trace is the durable evidence rather than an
artificially delayed screenshot.

## Dashboard quarantine behavior

![Dashboard with orders and payments cards](device-verification/issue-60/03-dashboard-debug-quarantined.png)

The dashboard contains cards contributed by `orders` and `payments` and labels
both as `platform: native`. It contains no `debug` card because the failed debug
module is quarantined.

## Logout finding and correction

![Render error before the correction](device-verification/issue-60/04-logout-render-error-before-fix.png)

The first logout drive-through exposed a real defect: an offscreen orders route
automatically reactivated the module as soon as its status became `disposed`,
while the auth deactivation cascade was still running. Auth then completed its
teardown, leaving the newly reactivated `OrdersCard` without
`auth/SessionService` and producing the LogBox above.

Route rendering now activates only a never-started `registered` module.
Reactivating a deliberately disposed module remains an explicit user action in
the drawer, so logout cannot be undone by an offscreen route effect.

![Drawer after logout](device-verification/issue-60/05-logout-menu-withdrawn.png)

After the correction, logout completes with no LogBox. The drawer shrinks from
seven entries to five: `auth/home` and `orders/detail` are withdrawn, while the
shell entry routes and `payments/drafts` remain.

![Dashboard after logout](device-verification/issue-60/06-logout-card-withdrawn.png)

Returning to Dashboard shows only the persistent payments card. The orders card
is withdrawn, the debug card remains absent, and the native screen stays
renderable after the full deactivation cascade.
