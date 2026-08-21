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

import { useState } from 'react';
import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { AppKernel } from '@ng-react/kernel';
import { createAppKernel } from './composition-root';
import { AppNavigation } from './shell/drawer';

export function App(): ReactElement {
  // One kernel, built lazily and kept for the life of the component. The
  // composition root exports a *factory* precisely so that this is possible
  // and so that a test can stand up its own isolated app.
  const [runtime] = useState(() => createAppKernel());

  return (
    <GestureHandlerRootView style={styles.root}>
      <AppKernel kernel={runtime.kernel}>
        <NavigationContainer>
          <View style={styles.root}>
            <StatusBar style="dark" />
            <AppNavigation />
          </View>
        </NavigationContainer>
      </AppKernel>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
