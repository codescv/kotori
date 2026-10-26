import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRepeat } from './RepeatControls';

describe('useRepeat (single-cue loop R / A-B)', () => {
  it('loops a cue `total` times then releases', () => {
    const seek = vi.fn();
    const { result, rerender } = renderHook(({ ms }) => useRepeat(ms, seek, 200), { initialProps: { ms: 1000 } });
    act(() => result.current.startCue(1000, 3000, 2));
    rerender({ ms: 3000 }); // end of play #1 → seek back
    expect(seek).toHaveBeenLastCalledWith(800);
    expect(result.current.state).toMatchObject({ kind: 'cue', done: 1 });
    rerender({ ms: 1200 });
    rerender({ ms: 3010 }); // end of play #2 → done
    expect(seek).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBeUndefined();
  });

  it('repeatCount 0 loops forever; A-B loops the selected range', () => {
    const seek = vi.fn();
    const { result, rerender } = renderHook(({ ms }) => useRepeat(ms, seek, 0), { initialProps: { ms: 0 } });
    act(() => result.current.startCue(0, 1000, 0));
    for (let i = 0; i < 5; i++) {
      rerender({ ms: 500 });
      rerender({ ms: 1000 });
    }
    expect(seek).toHaveBeenCalledTimes(5);
    expect(result.current.state?.kind).toBe('cue');
    act(() => result.current.startAb(2000, 9000));
    rerender({ ms: 9100 });
    expect(seek).toHaveBeenLastCalledWith(2000);
    act(() => result.current.stop());
    expect(result.current.state).toBeUndefined();
  });
});
