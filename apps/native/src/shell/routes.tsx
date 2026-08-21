// The native shell's providers: this host's top-level route table and the two
// drawer rows that reach the lazy modules (**C5**).
//
// Implementation, reached only through `./module`'s thunk at activation
// (**D1**). See that file for why the entry routes for lazy modules live here
// and not in the modules themselves.
//
// **B1**: this file imports `<pkg>/contract` and nothing else. It never sees a
// feature module's screen — those travel to the drawer as
// `RouteConfig.component` values contributed by their own modules — so the
// shell knows the *refs* of the lazy modules and none of their code.

import type { ComponentType, ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { contribute, useModule, useServiceAll } from '@ng-react/kernel';
import type { AnyProviderRecord, ModuleRef } from '@ng-react/kernel';
import { MenuEntryToken, RouteConfigToken } from '@app/nav/contract';
import { OrdersModule } from '@app/orders/contract';
import { PaymentsModule } from '@app/payments/contract';
import { renderTrace } from './render-trace';
import { theme } from './theme';

/** The demo's landing route. Owned by the shell, active for the app's whole life. */
function HomeScreen(): ReactElement {
  const routes = useServiceAll(RouteConfigToken);
  return (
    <View style={styles.screen} testID="home-screen">
      <Text style={theme.h1}>ng-react on React Native</Text>
      <Text style={theme.body}>
        {String(routes.length)} route(s) are registered right now, from{' '}
        <Text style={theme.code}>useServiceAll(nav/RouteConfig)</Text>. Open the drawer and tap{' '}
        <Text style={theme.code}>Orders section</Text> to watch a lazy module activate — a route
        and a drawer row that did not exist a moment ago will appear, because the module that
        contributes them was not running.
      </Text>
      <Text style={theme.note}>
        The same six module packages the web demo registers, unmodified, behind React Navigation
        instead of a hand-rolled navigator.
      </Text>
    </View>
  );
}

/**
 * Builds the shell-owned landing screen for a lazy module's section.
 *
 * A factory rather than one component per module, for the reason the web
 * shell gives: the only thing that varies is the ref.
 *
 * The drawer has already activated `ref` by the time this renders — it
 * renders a route's component only once the named module is `ready` — so
 * `useModule` here is reporting, not driving.
 */
function moduleSection(ref: ModuleRef, title: string): ComponentType {
  function ModuleSection(): ReactElement {
    const { status } = useModule(ref);
    const children = useServiceAll(RouteConfigToken).filter((route) =>
      route.path.startsWith(`/${ref.id}/`),
    );
    return (
      <View style={styles.screen} testID={`section-${ref.id}`}>
        <Text style={theme.h1}>{title}</Text>
        <Text style={theme.body}>
          <Text style={theme.code}>{ref.id}</Text> is{' '}
          <Text style={theme.strong}>{status}</Text>. It now contributes{' '}
          {String(children.length)} child route(s):{' '}
          {children.map((route) => route.path).join(', ') || 'none'}
        </Text>
        {/* **The evidence for the activating state**, and why it is a trace
            rather than a screenshot. The fallback below renders for the
            duration of one dynamic `import()` plus a synchronous `init` —
            single-digit milliseconds under Metro — so it is not photographable
            by any tooling that has to round-trip a tap and a screen capture.
            `renderTrace` is appended to by `ModuleRoute` on every status it
            actually rendered, so this line is a record of renders that
            happened rather than of transitions the kernel logged. */}
        <Text style={theme.note} testID={`route-trace-${ref.id}`}>
          Route render trace: {renderTrace.forModule(ref.id).join(' → ') || 'none'}
        </Text>
      </View>
    );
  }
  ModuleSection.displayName = `ModuleSection(${ref.id})`;
  return ModuleSection;
}

const OrdersSection = moduleSection(OrdersModule, 'Orders');
const PaymentsSection = moduleSection(PaymentsModule, 'Payments');

const styles = StyleSheet.create({
  screen: { flex: 1, gap: 12, padding: 20 },
});

/** ADR-10: `AnyProviderRecord`, never `ProviderRecord<unknown>[]`. */
export const providers: AnyProviderRecord[] = [
  contribute(RouteConfigToken, {
    factory: () => ({ path: '/', component: HomeScreen }),
  }),

  // **Spec §6**: "the navigation module activates a module when a parent
  // route config maps a matched path to its ref". These two rows are that
  // parent route config, and `module` is the only thing that distinguishes
  // them from an ordinary route.
  contribute(RouteConfigToken, {
    factory: () => ({ path: '/orders', module: OrdersModule, component: OrdersSection }),
  }),
  contribute(RouteConfigToken, {
    factory: () => ({ path: '/payments', module: PaymentsModule, component: PaymentsSection }),
  }),

  // **C5 — the drawer rows the web shell does not need.** A drawer has no
  // route table to browse, so the entry route for a lazy module needs a row
  // of its own or the module can never be reached. `order` puts them below
  // `auth`'s Home (0) and `dashboard`'s Dashboard (1) and above the rows the
  // feature modules contribute for themselves once they are up (10, 20) —
  // so activating `orders` visibly *inserts* rows between these and nothing
  // moves.
  //
  // No `owner` field on either: **C9** forbids it, and the drawer reads the
  // real owner out of `kernel.inspect()`.
  contribute(MenuEntryToken, {
    factory: () => ({ id: 'shell/home', title: 'Home (shell)', path: '/', order: 2 }),
  }),
  contribute(MenuEntryToken, {
    factory: () => ({ id: 'shell/orders', title: 'Orders section', path: '/orders', order: 3 }),
  }),
  contribute(MenuEntryToken, {
    factory: () => ({ id: 'shell/payments', title: 'Payments section', path: '/payments', order: 4 }),
  }),
];
