import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser, goToSignIn } from './session';

describe('goToSignIn', () => {
  let leave: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    leave = vi.spyOn(browser, 'leave').mockImplementation(() => {});
    window.history.replaceState(null, '', '/wolog/exercises?x=1#top');
  });

  it('goes to the sign-in page, coming back to this page', () => {
    expect(goToSignIn()).toBe(true);
    expect(leave).toHaveBeenCalledWith('/oauth2/start?rd=%2Fwolog%2Fexercises%3Fx%3D1%23top');
  });

  it('stops after three trips in two minutes, so a real loop ends', () => {
    const t = 1_000_000;
    expect(goToSignIn(t)).toBe(true);
    expect(goToSignIn(t + 1_000)).toBe(true);
    expect(goToSignIn(t + 2_000)).toBe(true);
    expect(goToSignIn(t + 3_000)).toBe(false);
    expect(leave).toHaveBeenCalledTimes(3);
  });

  it('goes again once the earlier trips are old', () => {
    const t = 1_000_000;
    for (const dt of [0, 1_000, 2_000]) goToSignIn(t + dt);
    expect(goToSignIn(t + 60_000)).toBe(false);
    expect(goToSignIn(t + 120_000)).toBe(true); // the first trip is now two minutes old
  });
});
