import { act, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { compatMediaRetryUrl, useMediaClock, type MediaClock } from './usePlayerSync';

describe('compatMediaRetryUrl', () => {
  it('appends compat=1 to host-node /media/ http(s) URLs', () => {
    expect(compatMediaRetryUrl('http://127.0.0.1:7865/media/ep1')).toBe('http://127.0.0.1:7865/media/ep1?compat=1');
    expect(compatMediaRetryUrl('https://kotori.local/media/ep1?token=a')).toBe('https://kotori.local/media/ep1?token=a&compat=1');
    expect(compatMediaRetryUrl('http://h/media/ep1?')).toBe('http://h/media/ep1?compat=1');
    expect(compatMediaRetryUrl('http://h/media/ep1#t=10')).toBe('http://h/media/ep1?compat=1#t=10');
  });

  it('does not retry when already in compat mode or not a host-node stream', () => {
    expect(compatMediaRetryUrl('http://h/media/ep1?compat=1')).toBeUndefined();
    expect(compatMediaRetryUrl('http://h/media/ep1?x=1&compat=1')).toBeUndefined();
    expect(compatMediaRetryUrl('capacitor://localhost/_capacitor_file_/v/a.mkv')).toBeUndefined();
    expect(compatMediaRetryUrl('https://localhost/_capacitor_file_/v/a.mkv')).toBeUndefined();
    expect(compatMediaRetryUrl('mock://episode/1')).toBeUndefined();
    expect(compatMediaRetryUrl('/media/ep1')).toBeUndefined(); // relative: the hook passes the resolved `src`
    expect(compatMediaRetryUrl('')).toBeUndefined();
    expect(compatMediaRetryUrl(undefined)).toBeUndefined();
  });
});

describe('useMediaClock compat retry', () => {
  function Harness({ src, onClock }: { src: string; onClock: (c: MediaClock) => void }) {
    const ref = useRef<HTMLVideoElement | null>(null);
    onClock(useMediaClock(ref));
    return <video ref={ref} src={src} data-testid="v" />;
  }

  function setup(src: string) {
    let clock: MediaClock | undefined;
    const utils = render(<Harness src={src} onClock={(c) => (clock = c)} />);
    const video = utils.getByTestId('v') as HTMLVideoElement;
    return { video, clock: () => clock! };
  }

  it('retries a failing /media/ stream once with ?compat=1 before simulating', () => {
    const { video, clock } = setup('http://127.0.0.1:7865/media/ep1');
    act(() => {
      fireEvent.error(video);
    });
    expect(video.src).toBe('http://127.0.0.1:7865/media/ep1?compat=1');
    expect(clock().simulated).toBe(false);

    act(() => {
      fireEvent.error(video);
    });
    expect(video.src).toBe('http://127.0.0.1:7865/media/ep1?compat=1');
    expect(clock().simulated).toBe(true);
  });

  it('resolves relative /media/ URLs against the page before retrying', () => {
    const { video, clock } = setup('/media/ep2');
    act(() => {
      fireEvent.error(video);
    });
    expect(video.src).toBe(new URL('/media/ep2?compat=1', document.baseURI).href);
    expect(clock().simulated).toBe(false);
  });

  it('switches straight to the simulated clock for non-host-node sources', () => {
    const { video, clock } = setup('mock://episode/1');
    act(() => {
      fireEvent.error(video);
    });
    expect(video.getAttribute('src')).toBe('mock://episode/1');
    expect(clock().simulated).toBe(true);
  });
});
