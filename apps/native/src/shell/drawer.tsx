// **The drawer — this app's whole navigation surface, and it is three
// `useServiceAll` calls.**
//
// Issue #53: "the drawer *is* the hamburger menu; its items come from the menu
// collection and appear/disappear with module lifecycle."
//
// **App chrome, not a module**, exactly as `apps/react/src/shell/menu.tsx` is.
// `MenuEntry` carries no `component` field — a menu entry is a label and a
// destination — which is precisely what lets a `<details>` disclosure on web
// and a React Navigation drawer here render the *same* collection with no
// module changed. That claim was written down in #52 with no way to test it;
// this file is the test.
//
// **B1**: this file imports `<pkg>/contract` and nothing else.
//
// ---
//
// ### What this file is *not*, and the finding behind it
//
// It is not `@app/nav`'s `RootNavigator`. That component is provided through
// `NavigatorToken` and is web-only DOM (`<section>`, `<ul>`, `<button>`), so
// on native it is registered, resolvable, and never resolved. That is a real
// observation about the platform-extension decision's edges and it is
// reported in the PR body rather than papered over: a module may own a
// component that is unusable on one platform without anything breaking,
// because a component only ever crosses a boundary as a *value* and an unasked
// -for value costs nothing but bundle size. The same goes for `RouterToken`:
// React Navigation's own navigation state is this host's router, so `nav`'s
// in-memory `Router` service is likewise never resolved here.
//
// The alternative — splitting `navigator.tsx` into `navigator.web.tsx` /
// `navigator.native.tsx` — would put a second, duplicate drawer inside
// `@app/nav`, and would be a change to a feature module that this task's
// issue says must be reused unmodified. Not done, deliberately.

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  createDrawerNavigator,
  DrawerContentScrollView,
  DrawerItem,
} from '@react-navigation/drawer';
import type { DrawerContentComponentProps } from '@react-navigation/drawer';
import { useKernel, useModule, useServiceAll } from '@ng-react/kernel';
import type { ModuleRef } from '@ng-react/kernel';
import { AuthModule } from '@app/auth/contract';
import { MenuEntryToken, RouteConfigToken } from '@app/nav/contract';
import type { RouteConfig } from '@app/nav/contract';
import { OrdersModule } from '@app/orders/contract';
import { ownedInDisplayOrder, ownersOf } from './ordering';
import { renderTrace } from './render-trace';
import { theme } from './theme';

/**
 * Every drawer screen takes the same one parameter: the `RouteConfig.path` it
 * shows. `Record<string, …>` because the screen *names* are the menu entry ids,
 * which are contributed at runtime by whichever modules are active — a
 * statically enumerated param list is not expressible for a route table that
 * grows and shrinks with module lifecycle, and that is the honest typing of
 * what this app is.
 */
type DrawerParamList = Record<string, { readonly path: string }>;

const Drawer = createDrawerNavigator<DrawerParamList>();

/**
 * **Spec §6 — route-driven activation, translated into `kernel.activate`.**
 *
 * The native twin of `@app/nav`'s `ModuleRoute`, and the same nine lines: "the
 * kernel itself has no notion of route-driven activation. Subsystem modules
 * built on the kernel translate their own triggers into `kernel.activate(ref)`."
 *
 * **It renders a fallback rather than awaiting activation**, which is the point
 * rather than a detail: a drawer that awaited `activate()` before rendering
 * anything would hide `activating` — the one status **A2** exposes to React so
 * that a UI can show it — and would make a slow `init` look like a frozen app.
 */
function ModuleRoute(props: {
  readonly moduleRef: ModuleRef;
  readonly component: RouteConfig['component'];
}): ReactElement {
  const kernel = useKernel();
  // **A2/R3**: re-renders on every status transition, which turns
  // `activating → ready` into a repaint with no polling of our own.
  const { status, error, retry } = useModule(props.moduleRef);

  // Recorded from the render body rather than from an effect: the claim is
  // "this status was *rendered*", and an effect fires after the commit for a
  // status that may already have been superseded. See `render-trace.ts`.
  renderTrace.record(props.moduleRef.id, status);

  useEffect(() => {
    // **A2**: `activate` is idempotent and single-flight, so this is safe from
    // an effect that may run twice and safe for a module already `activating`.
    // `disposed` is included because logout (**A4**) leaves a routed-to module
    // exactly there, and a route that could never come back would be dead.
    if (status === 'registered' || status === 'disposed') {
      // The failure is retained on the module (**F1**) and rendered below;
      // rethrowing into an unhandled rejection would add nothing.
      void kernel.activate(props.moduleRef).catch(() => {});
    }
  }, [kernel, props.moduleRef, status]);

  if (status === 'ready') {
    const Screen = props.component;
    return <Screen />;
  }

  if (status === 'failed') {
    // **F3**: the module is quarantined and `retry` re-attempts it.
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
    return (
      <View style={styles.screen} testID="route-failed">
        <Text style={theme.h1}>{props.moduleRef.id} could not be activated</Text>
        <Text style={theme.body}>{message}</Text>
        <Pressable style={styles.button} onPress={retry} testID="route-retry">
          <Text style={styles.buttonText}>Retry {props.moduleRef.id}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen} testID="route-fallback">
      <Text style={theme.h1}>Activating {props.moduleRef.id}…</Text>
      <Text style={theme.body}>
        Status <Text style={theme.strong}>{status}</Text>. A2 exposes this to React so a UI can
        render it; the drawer does not await activation.
      </Text>
    </View>
  );
}

/**
 * One drawer screen: resolve the path against the live route table and render
 * whatever the table says.
 *
 * **R3/C5** — the route table is `useServiceAll(RouteConfigToken)` and nothing
 * else, so a module activating adds its routes and a module being disposed or
 * quarantined (**F3**) withdraws them, with no registry here to keep in step.
 * Matching is exact-path and deliberately dumb: patterns, params and guards are
 * spec 03's job.
 */
function RouteScreen(props: {
  readonly route: { readonly params?: { readonly path?: string } };
}): ReactElement {
  const path = props.route.params?.path ?? '/';
  const routes = useServiceAll(RouteConfigToken);
  const match = routes.find((route) => route.path === path);

  if (match === undefined) {
    return (
      <View style={styles.screen} testID="route-not-found">
        <Text style={theme.h1}>No route matches {path}</Text>
        <Text style={theme.body}>
          The table holds {String(routes.length)} route(s); a module that is not active
          contributes none.
        </Text>
      </View>
    );
  }

  if (match.module === undefined) {
    return <match.component />;
  }

  return <ModuleRoute moduleRef={match.module} component={match.component} />;
}

/**
 * **The drawer's contents — `useServiceAll(nav/MenuEntry)`, C9 attribution,
 * and two buttons.**
 *
 * Custom content rather than the default `DrawerItemList` for one reason: the
 * owner of each row comes from `kernel.inspect()` (**C9**) and has to be
 * rendered next to it, which is the whole demonstration. The rows are built
 * from the *collection*, not from React Navigation's own `state.routes`, so
 * what is on screen is the collection and not a cache of it.
 */
function AppDrawerContent(props: DrawerContentComponentProps): ReactElement {
  const kernel = useKernel();
  // **R3/C5** — the whole menu. Rows appear when a module activates and are
  // withdrawn when it is disposed or quarantined (**F3**).
  const entries = useServiceAll(MenuEntryToken);
  const ordered = ownedInDisplayOrder(entries, ownersOf(kernel, MenuEntryToken));
  const activeName = props.state.routes[props.state.index]?.name;

  const activateOrders = useCallback(() => {
    void kernel.activate(OrdersModule).catch(() => {});
  }, [kernel]);

  const logout = useCallback(() => {
    void kernel.deactivate(AuthModule).catch(() => {});
  }, [kernel]);

  return (
    <DrawerContentScrollView {...props} testID="app-drawer">
      <View style={styles.drawerHeader}>
        <Text style={theme.h2}>Menu ({String(ordered.length)})</Text>
        <Text style={theme.note}>
          useServiceAll(nav/MenuEntry). Attribution from kernel.inspect() (C9), never from the
          entry.
        </Text>
      </View>

      {ordered.map(({ value: entry, owner }) => (
        <DrawerItem
          key={entry.id}
          testID={`menu-item-${entry.id}`}
          focused={entry.id === activeName}
          label={() => (
            <View>
              <Text style={theme.strong}>{entry.title}</Text>
              <Text style={theme.owner}>
                {entry.path} · contributed by {owner}
              </Text>
            </View>
          )}
          onPress={() => {
            props.navigation.navigate(entry.id);
          }}
        />
      ))}

      <View style={styles.drawerFooter}>
        <Pressable style={styles.button} onPress={activateOrders} testID="action-activate-orders">
          <Text style={styles.buttonText}>Activate orders</Text>
        </Pressable>
        <Pressable style={styles.buttonDanger} onPress={logout} testID="action-logout">
          <Text style={styles.buttonText}>Logout (deactivate auth)</Text>
        </Pressable>
        <Text style={theme.note}>
          A4 cascades to the modules that depend on auth — orders, then auth. payments depends on
          nothing and stays ready.
        </Text>
      </View>
    </DrawerContentScrollView>
  );
}

/**
 * The navigator itself.
 *
 * One `<Drawer.Screen>` per menu entry, built from the live collection — so a
 * module activating literally adds a screen and a module being disposed removes
 * one. React Navigation's dynamic API is what makes that expressible; the
 * static API (and Expo Router, which #53 explicitly excludes) wants the screen
 * set known at build time, which is the opposite of what a contribution
 * collection is for.
 *
 * `component={RouteScreen}` with `initialParams`, never an inline
 * `children`/`getComponent` closure: a fresh component identity on every render
 * would remount the screen on every collection notification and throw away its
 * state.
 */
export function AppDrawer(): ReactElement {
  const kernel = useKernel();
  const entries = useServiceAll(MenuEntryToken);
  const ordered = ownedInDisplayOrder(entries, ownersOf(kernel, MenuEntryToken));

  return (
    <Drawer.Navigator
      // A fresh arrow on every render is what React Navigation's
      // `drawerContent` API takes; `AppDrawerContent` itself is a stable
      // identity, so nothing remounts.
      drawerContent={(props) => <AppDrawerContent {...props} />}
      screenOptions={{ headerShown: true }}
    >
      {ordered.map(({ value: entry }) => (
        <Drawer.Screen
          key={entry.id}
          name={entry.id}
          component={RouteScreen}
          initialParams={{ path: entry.path }}
          options={{ title: entry.title }}
        />
      ))}
    </Drawer.Navigator>
  );
}

/**
 * The drawer, or a plain screen while `nav` and `dashboard` are still coming
 * up.
 *
 * A `<Drawer.Navigator>` with no screens throws, and the collection is
 * genuinely empty for the first paint: the eager activation pass is
 * asynchronous, so nothing has contributed a `MenuEntry` yet when React first
 * renders. That is not a defect to hide — it is **A2**'s `activating` at the
 * app level, and rendering it is the same choice `ModuleRoute` makes one level
 * down.
 */
export function AppNavigation(): ReactElement {
  const entries = useServiceAll(MenuEntryToken);
  // `useModule` for the same reason `apps/react/src/App.tsx` pairs it with
  // `useServiceOptional`: a collection notification re-renders this, but the
  // *first* one only arrives once something contributes, and the empty case
  // has to render something in the meantime.
  const [startedAt] = useState(() => Date.now());

  if (entries.length === 0) {
    return (
      <View style={styles.screen} testID="app-starting">
        <Text style={theme.h1}>Starting…</Text>
        <Text style={theme.body}>
          No module has contributed a menu entry yet. The eager activation pass is asynchronous, so
          this is the app's own `activating` state.
        </Text>
        <Text style={theme.note}>since {new Date(startedAt).toLocaleTimeString()}</Text>
      </View>
    );
  }

  return <AppDrawer />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: 12, padding: 20 },
  drawerHeader: { gap: 4, paddingBottom: 8, paddingHorizontal: 16 },
  drawerFooter: { gap: 10, paddingHorizontal: 16, paddingTop: 16 },
  button: {
    alignItems: 'center',
    backgroundColor: '#0b5f8a',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonDanger: {
    alignItems: 'center',
    backgroundColor: '#8a2b2b',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonText: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
});
