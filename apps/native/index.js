// Metro's entry point (`package.json` "main").
//
// `registerRootComponent` is Expo's `AppRegistry.registerComponent` plus the
// splash/keep-awake wiring; it is the one thing an Expo app's entry file does.
// Everything else lives in `src/App.tsx`, which is ordinary application code.
import { registerRootComponent } from 'expo';

import { App } from './src/App';

registerRootComponent(App);
