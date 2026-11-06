import { afterEach, describe, expect, it, vi } from 'vitest';
import { idleOnce } from './idle';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('idleOnce', () => {
  it('дело — в простое (requestIdleCallback с пределом), не сразу; просьбы, пока ждёт, — одно дело', () => {
    const queue: { cb: () => void; timeout?: number }[] = [];
    vi.stubGlobal('requestIdleCallback', (cb: () => void, o?: { timeout?: number }) => queue.push({ cb, timeout: o?.timeout }));
    const fn = vi.fn();
    const soon = idleOnce(fn, 1500);
    soon();
    soon();
    soon();
    expect(fn).not.toHaveBeenCalled();
    expect(queue).toHaveLength(1);
    expect(queue[0].timeout).toBe(1500);
    queue.shift()!.cb();
    expect(fn).toHaveBeenCalledTimes(1);
    // Сделано — следующая просьба снова ставит дело в очередь.
    soon();
    expect(queue).toHaveLength(1);
    queue.shift()!.cb();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('без requestIdleCallback — через setTimeout, тоже не сразу', () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.useFakeTimers();
    const fn = vi.fn();
    const soon = idleOnce(fn);
    soon();
    soon();
    expect(fn).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
