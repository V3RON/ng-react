// The demo's text styles, in one place.
//
// Deliberately plain: `StyleSheet.create` and nothing else. No UI framework
// and no styling dependency, mirroring `apps/react/src/App.css`'s restraint —
// every screen in this app exists to show one kernel guarantee, and nothing
// here is decoration beyond making the screenshots legible.

import { StyleSheet } from 'react-native';

export const theme = StyleSheet.create({
  h1: { fontSize: 22, fontWeight: '700', color: '#101418' },
  h2: { fontSize: 17, fontWeight: '700', color: '#101418' },
  body: { fontSize: 15, lineHeight: 21, color: '#25303a' },
  strong: { fontWeight: '700', color: '#101418' },
  code: { fontFamily: 'Menlo', fontSize: 13, color: '#0b5f8a' },
  note: { fontSize: 12, lineHeight: 17, color: '#5a6b78' },
  owner: { fontSize: 11, color: '#7b5cd6' },
});
