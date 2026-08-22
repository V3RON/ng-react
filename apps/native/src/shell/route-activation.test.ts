import { shouldActivateFromRoute } from './route-activation';

describe('route-driven activation', () => {
  it('activates a registered lazy module', () => {
    expect(shouldActivateFromRoute('registered')).toBe(true);
  });

  it('does not undo an intentional deactivation', () => {
    expect(shouldActivateFromRoute('disposed')).toBe(false);
  });
});
