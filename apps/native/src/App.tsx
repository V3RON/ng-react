// The native demo's root component.
//
// **R1**: exactly one `<AppKernel>` per kernel, and the kernel is built once —
// `useState`'s initializer rather than a module-scope `createAppKernel()` call,
// so importing this file has no side effects and Fast Refresh cannot construct
// a second one.
//
// **B1**: this file imports the composition root (which is what a root is for)
// and `<pkg>/contract` for nothing else. The drawer and the screens reach every
// module through its contract.

import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { AppKernel } from '@ng-react/kernel';
import { createAppKernel } from './composition-root';
import { StartupGate } from './shell/startup';

// At module scope, not in an effect: Expo hides the splash shortly after the
// bundle evaluates, which can be before the first effect runs. The rejection
// is swallowed because it means there was no splash to hold. `hideAsync()`,
// the other half, is passed to `<StartupGate>` below.
void SplashScreen.preventAutoHideAsync().catch(() => {});

export function App(): ReactElement {
  // One kernel, built lazily and kept for the life of the component. The
  // composition root exports a *factory* precisely so that this is possible
  // and so that a test can stand up its own isolated app.
  const [runtime] = useState(() => createAppKernel());
  // Stable across renders, so `<StartupGate>`'s effect does not re-run for a
  // fresh closure.
  const hideSplash = useCallback(async (): Promise<void> => {
    await SplashScreen.hideAsync();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <AppKernel kernel={runtime.kernel}>
        <View style={styles.root}>
          <StatusBar style="dark" />
          {/* Nothing below this renders until the app's startup-critical
              modules are ready. `<NavigationContainer>` sits inside the gate:
              a navigator mounted over modules that have not started comes up
              empty and fills in under the user. */}
          <StartupGate hideSplash={hideSplash} />
        </View>
      </AppKernel>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
