// `@app/debug` — the module's React components, **React Native implementation**.
//
// The platform decision this file is the other half of is written up once, in
// `packages/dashboard/src/screen.web.tsx`; the checklist that turned this file
// from a placeholder into an implementation is discharged and recorded in
// `packages/dashboard/src/screen.native.tsx`.
//
// **Nothing in this workspace ever renders this component, on either
// platform**, and that is the point of the module. `debug`'s `init` throws on
// purpose, so **F3** withdraws the `DashboardCardToken` contribution its
// `providers.ts` had already registered, and the card never reaches the
// dashboard. The component exists so that the absence is caused by quarantine
// rather than by there being nothing to withdraw.
//
// It is written as a real React Native component rather than left as a stub
// for exactly that reason: a card whose component could not render would give
// F3 a second, accidental explanation for the card being missing, and "absent
// because withdrawn" and "absent because broken" are the two things the
// dashboard test exists to tell apart.

import type { ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useService } from '@ng-react/kernel';
import { DebugProbeToken } from './contract';

/** Would render `debug`'s probe, if `debug` ever activated successfully. */
export function DebugCard(): ReactElement {
  const probe = useService(DebugProbeToken);
  return (
    <Text style={styles.body} testID="debug-card">
      {probe.describe()} · platform: native
    </Text>
  );
}

const styles = StyleSheet.create({
  body: { color: '#25303a', fontSize: 15, lineHeight: 21 },
});
