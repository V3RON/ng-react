// `render-trace.ts` — the record of what the route outlet actually rendered.
//
// The trace is the evidence for issue #53's "the activating state, then the
// screen" observation, so its own behaviour has to be pinned: a trace that
// silently collapsed `activating → ready` into `ready` would report the same
// thing whether the fallback rendered or not, and the observation it backs
// would be worthless.

import { renderTrace } from './render-trace';

describe('renderTrace', () => {
  it('records the sequence of statuses a module’s outlet rendered', () => {
    renderTrace.record('probe-a', 'registered');
    renderTrace.record('probe-a', 'activating');
    renderTrace.record('probe-a', 'ready');

    expect(renderTrace.forModule('probe-a')).toEqual(['registered', 'activating', 'ready']);
  });

  it('deduplicates consecutive repeats, because React re-renders a component many times per status', () => {
    // Without this, one status would appear as many times as React happened to
    // re-render — a parent re-render, a C5 notification, StrictMode's double
    // invoke — and the trace would be noise rather than a sequence.
    renderTrace.record('probe-b', 'activating');
    renderTrace.record('probe-b', 'activating');
    renderTrace.record('probe-b', 'activating');
    renderTrace.record('probe-b', 'ready');

    expect(renderTrace.forModule('probe-b')).toEqual(['activating', 'ready']);
  });

  it('records a status again when it recurs after a different one — a re-activation is not a repeat', () => {
    // Logout leaves a routed-to module `disposed` and the drawer re-activates
    // it on the next visit (**A4**, and `ModuleRoute`'s `disposed` branch). The
    // second `ready` is a different event from the first and the trace has to
    // say so, which is why the dedupe compares against the latest entry for
    // *that module* rather than against the set of statuses already seen.
    renderTrace.record('probe-c', 'ready');
    renderTrace.record('probe-c', 'disposed');
    renderTrace.record('probe-c', 'activating');
    renderTrace.record('probe-c', 'ready');

    expect(renderTrace.forModule('probe-c')).toEqual([
      'ready',
      'disposed',
      'activating',
      'ready',
    ]);
  });

  it('keeps modules separate: interleaved renders do not dedupe against each other', () => {
    // The outlets for two modules render in the same commit whenever the
    // drawer has both mounted. Deduplicating against the global tail rather
    // than per module would drop the second module's status.
    renderTrace.record('probe-d', 'activating');
    renderTrace.record('probe-e', 'activating');
    renderTrace.record('probe-d', 'ready');
    renderTrace.record('probe-e', 'ready');

    expect(renderTrace.forModule('probe-d')).toEqual(['activating', 'ready']);
    expect(renderTrace.forModule('probe-e')).toEqual(['activating', 'ready']);
  });
});
