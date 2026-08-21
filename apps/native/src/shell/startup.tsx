// What the app renders on either side of the startup gate, and where the
// native splash screen is released.
//
// This file uses `useKernelStartup()` rather than `<KernelStartupGate>`,
// because hiding the splash is a side effect on the transition rather than a
// rendering of it.

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { useKernelStartup } from '@ng-react/kernel';
import { AppNavigation } from './drawer';
import { theme } from './theme';

/**
 * Renders the app once the kernel's eager critical modules are ready, or the
 * failure screen if one of them could not be, and hides the splash screen
 * when startup settles either way.
 *
 * Renders nothing while startup is still running: the native splash screen is
 * a real screen and is still on top.
 *
 * The gate waits for `auth`, the app's one eager critical module. `debug`
 * fails on purpose, and `nav`, `dashboard` and `shell` are eager but not
 * critical; none of them can hold the splash up.
 *
 * @param hideSplash Called exactly once, when startup settles. Taken as a
 *   parameter so that it sits beside `preventAutoHideAsync()` in `App.tsx`
 *   rather than in a second file.
 */
export function StartupGate(props: {
  readonly hideSplash: () => Promise<void>;
}): ReactElement | null {
  const startup = useKernelStartup();
  const { hideSplash } = props;
  // A ref rather than the effect's own scheduling: under Fast Refresh an
  // effect runs more than once per mount, and the splash is hidden once.
  const hidden = useRef(false);
  useEffect(() => {
    if (startup.status === 'pending' || hidden.current) {
      return;
    }
    hidden.current = true;
    void hideSplash();
  }, [startup, hideSplash]);

  if (startup.status === 'pending') {
    return null;
  }
  if (startup.status === 'failed') {
    return <StartupFailed error={startup.error} />;
  }
  return (
    <NavigationContainer>
      <AppNavigation />
    </NavigationContainer>
  );
}

/**
 * Shown instead of the app when an eager critical module could not start.
 *
 * The kernel's own error is rendered verbatim: it names the module and the
 * phase. There is no retry control, because a kernel whose critical startup
 * failed does not start again.
 */
function StartupFailed(props: { readonly error: unknown }): ReactElement {
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <View style={styles.screen}>
      <Text style={theme.h1}>Startup failed</Text>
      <Text style={theme.note}>
        F2: an eager critical module could not become ready, so
        kernel.whenStartupComplete() rejected and the app was never rendered. The splash screen is
        gone rather than stuck — a gate that handled only the success path would still be showing
        it.
      </Text>
      <Text style={theme.code}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: 12, justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
});
