// useAutoCloseBelow: jsdom has no matchMedia, so a controllable fake stands in.
// The behavior contract: fire once on the downward crossing (including "started
// narrow"), never on the upward crossing, never on re-render.

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCloseBelow } from "./useAutoCloseBelow";

type ChangeListener = (e: MediaQueryListEvent) => void;

function mockMatchMedia(initialMatches: boolean) {
  const listeners = new Set<ChangeListener>();
  const mql = {
    matches: initialMatches,
    media: "(max-width: 1150px)",
    onchange: null,
    addEventListener: (_: string, l: ChangeListener) => listeners.add(l),
    removeEventListener: (_: string, l: ChangeListener) => listeners.delete(l),
    addListener: (l: ChangeListener) => listeners.add(l),
    removeListener: (l: ChangeListener) => listeners.delete(l),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  window.matchMedia = vi.fn().mockReturnValue(mql);
  return {
    /** Simulate the viewport crossing the threshold; browsers only fire on a real crossing. */
    cross(matches: boolean) {
      (mql as { matches: boolean }).matches = matches;
      listeners.forEach((l) => l({ matches } as MediaQueryListEvent));
    },
  };
}

afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("useAutoCloseBelow", () => {
  it("fires once when the viewport crosses downward, and again on the next crossing", () => {
    const mq = mockMatchMedia(false);
    const onCrossDown = vi.fn();
    const { rerender } = renderHook(() => useAutoCloseBelow("(max-width: 1150px)", onCrossDown));

    expect(onCrossDown).not.toHaveBeenCalled(); // wide at mount — nothing to do

    mq.cross(true);
    expect(onCrossDown).toHaveBeenCalledTimes(1);

    rerender(); // a re-render while still narrow must not re-fire
    expect(onCrossDown).toHaveBeenCalledTimes(1);

    mq.cross(false); // upward crossing — never close, never reopen
    expect(onCrossDown).toHaveBeenCalledTimes(1);

    mq.cross(true); // a fresh downward crossing fires once more
    expect(onCrossDown).toHaveBeenCalledTimes(2);
  });

  it("treats a window that starts narrow as a crossing (closes up front, once)", () => {
    mockMatchMedia(true);
    const onCrossDown = vi.fn();
    renderHook(() => useAutoCloseBelow("(max-width: 1150px)", onCrossDown));
    expect(onCrossDown).toHaveBeenCalledTimes(1);
  });

  it("does nothing when matchMedia is unavailable", () => {
    const onCrossDown = vi.fn();
    renderHook(() => useAutoCloseBelow("(max-width: 1150px)", onCrossDown));
    expect(onCrossDown).not.toHaveBeenCalled();
  });
});
