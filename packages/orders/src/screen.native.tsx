// `@app/orders` — the module's React components, **React Native implementation**.
//
// The platform decision this file is the other half of is written up once, in
// `packages/dashboard/src/screen.web.tsx`; the checklist that turned this file
// from a placeholder into an implementation is discharged and recorded in
// `packages/dashboard/src/screen.native.tsx`. Neither is repeated here.
//
// What is worth saying *here* is what did **not** have to change: the two
// components below take the same props (none), resolve the same tokens through
// the same hooks, and are contributed by the same single `contribute()` call in
// the same platform-agnostic `providers.ts` as their web siblings. `providers.ts`
// is untouched by this task. That is the whole claim of #52 §3, and it holds.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useService } from '@ng-react/kernel';
import { OrderServiceToken } from './contract';

/**
 * **R2**: resolves `orders`' own service through the container. Referential
 * stability is R2's guarantee for `singleton` and `module` scopes, so the
 * instance is the same across renders — and a *different* one after an HMR
 * re-activation, because **H6** bumps the epoch this hook subscribes to. The
 * component needs no HMR awareness of its own.
 */
export function OrdersScreen(): ReactElement {
  const service = useService(OrderServiceToken);
  const [error, setError] = useState<string | undefined>(undefined);
  const [, setTick] = useState(0);

  const place = (): void => {
    void service
      .place(2500)
      .then(() => {
        setError(undefined);
        setTick((value) => value + 1);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <View style={styles.screen} testID="orders-screen">
      <Text style={styles.heading}>Orders</Text>
      <Text style={styles.body} testID="orders-placed">
        {String(service.placed().length)} order(s) placed
      </Text>
      <Text style={styles.body} testID="orders-session-changes">
        {String(service.sessionChanges())} session change(s) seen by the init listener
      </Text>
      <Pressable style={styles.button} onPress={place} testID="orders-place">
        <Text style={styles.buttonText}>Place a 25.00 EUR order</Text>
      </Pressable>
      {error === undefined ? null : (
        <Text style={styles.error} testID="orders-error">
          {error}
        </Text>
      )}
    </View>
  );
}

/**
 * **The module's dashboard card** — the `component` half of `orders`'
 * `contribute(DashboardCardToken, …)`.
 *
 * It resolves `orders`' own service (**R2**), so it is present exactly while
 * `orders` is active: activating the module adds it to the collection and
 * logout (**A4**) withdraws it, with no dashboard code involved.
 */
export function OrdersCard(): ReactElement {
  const service = useService(OrderServiceToken);
  return (
    <Text style={styles.body} testID="orders-card">
      {String(service.placed().length)} recent order(s) · platform: native
    </Text>
  );
}

const styles = StyleSheet.create({
  body: { color: '#25303a', fontSize: 15, lineHeight: 21 },
  button: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#0b5f8a',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonText: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  error: { color: '#8a2b2b', fontSize: 13 },
  heading: { color: '#101418', fontSize: 22, fontWeight: '700' },
  screen: { flex: 1, gap: 12, padding: 20 },
});
