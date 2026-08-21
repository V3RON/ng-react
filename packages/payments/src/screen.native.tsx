// `@app/payments` — the module's React components, **React Native implementation**.
//
// The platform decision this file is the other half of is written up once, in
// `packages/dashboard/src/screen.web.tsx`; the checklist that turned this file
// from a placeholder into an implementation is discharged and recorded in
// `packages/dashboard/src/screen.native.tsx`. Neither is repeated here.
//
// `providers.ts` is untouched: one `contribute(DashboardCardToken, …)` call
// carries `PaymentsCard` on both platforms, and the resolver decides which one.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useService } from '@ng-react/kernel';
import { PaymentDraftStoreToken, PaymentGatewayToken } from './contract';

export function PaymentsScreen(): ReactElement {
  const gateway = useService(PaymentGatewayToken);
  const drafts = useService(PaymentDraftStoreToken);
  const [lastAuthorization, setLastAuthorization] = useState<string | undefined>(undefined);

  const authorize = (): void => {
    void gateway
      .authorize({ amountMinor: 4200, currency: 'EUR' }, 'demo-basket')
      .then((authorization) => {
        setLastAuthorization(authorization.id);
      })
      .catch(() => {
        setLastAuthorization(undefined);
      });
  };

  return (
    <View style={styles.screen} testID="payments-screen">
      <Text style={styles.heading}>Payments</Text>
      {/* **H3**: the persistent store's contents survive an edit to this
          module and are discarded by a real `deactivate`. */}
      <Text style={styles.body} testID="payments-drafts">
        {String(drafts.getState().length)} draft(s) held (persistent: true)
      </Text>
      {/* The authorization id embeds the `MODULE_ID` the gateway was built for
          (**C4**) — `'app'` here, because a component outside any
          `<ModuleScope>` resolves with ADR-2's reserved requester. */}
      <Text style={styles.body} testID="payments-authorization">
        {lastAuthorization ?? 'nothing authorized yet'}
      </Text>
      <Pressable style={styles.button} onPress={authorize} testID="payments-authorize">
        <Text style={styles.buttonText}>Authorize the demo basket</Text>
      </Pressable>
    </View>
  );
}

/**
 * **The module's dashboard card** — pending drafts, deliberately.
 *
 * The draft store is `payments`' `persistent: true` provider (**H3**, **H4**),
 * so this card is where an HMR edit would be *visible* — on a bundler that
 * hot-replaces the module. Under Metro it does not (see
 * `packages/payments/src/module.ts`'s portability note and this PR's HMR
 * section), which makes this card the place that shows the *absence* rather
 * than the presence.
 */
export function PaymentsCard(): ReactElement {
  const drafts = useService(PaymentDraftStoreToken);
  return (
    <Text style={styles.body} testID="payments-card">
      {String(drafts.getState().length)} pending draft(s) — persistent: true · platform: native
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
  heading: { color: '#101418', fontSize: 22, fontWeight: '700' },
  screen: { flex: 1, gap: 12, padding: 20 },
});
