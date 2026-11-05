import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchBackNavigation } from '../../app/routes';
import { resetStores } from '../../test/utils';
import { Dialog } from './Dialog';

/** Caller that re-renders on every keystroke and passes a fresh inline `onClose` each time. */
function TypingDialog({ onClosed, autofocusTitle = false }: { onClosed: (snapshot: string) => void; autofocusTitle?: boolean }) {
  const [open, setOpen] = useState(true);
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  return (
    <>
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
        reopen
      </button>
      <Dialog
        open={open}
        // Deliberately unmemoized: a new function identity on every render.
        onClose={() => {
          onClosed(`${email}|${title}|${details}`);
          setOpen(false);
        }}
        title="Feedback"
        data-testid="typing-dialog"
      >
        <input data-testid="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
        <input
          data-testid="title"
          value={title}
          data-autofocus={autofocusTitle ? 'true' : undefined}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <textarea data-testid="details" value={details} onChange={(e) => setDetails(e.currentTarget.value)} />
      </Dialog>
    </>
  );
}

function typeInto(el: HTMLElement, text: string): void {
  let value = (el as HTMLInputElement).value;
  for (const ch of text) {
    value += ch;
    fireEvent.change(el, { target: { value } });
    expect(document.activeElement).toBe(el);
  }
}

describe('Dialog', () => {
  beforeEach(resetStores);
  afterEach(cleanup);

  it('focuses the first field once on open and never steals focus back while the caller re-renders per keystroke', () => {
    const onClosed = vi.fn();
    render(<TypingDialog onClosed={onClosed} />);
    const email = screen.getByTestId('email');
    const title = screen.getByTestId('title');
    const details = screen.getByTestId('details');
    expect(document.activeElement).toBe(email);

    act(() => title.focus());
    typeInto(title, '字幕不同步');
    expect(title).toHaveValue('字幕不同步');
    expect(document.activeElement).toBe(title);

    act(() => details.focus());
    typeInto(details, 'Line one\nLine two');
    expect(details).toHaveValue('Line one\nLine two');
    expect(document.activeElement).toBe(details);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('honours [data-autofocus] for the initial focus target', () => {
    render(<TypingDialog onClosed={vi.fn()} autofocusTitle />);
    expect(document.activeElement).toBe(screen.getByTestId('title'));
  });

  it('Escape invokes the latest inline onClose with the freshest state', () => {
    const onClosed = vi.fn();
    render(<TypingDialog onClosed={onClosed} />);
    const title = screen.getByTestId('title');
    act(() => title.focus());
    typeInto(title, 'abc');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenLastCalledWith('|abc|');
    expect(screen.queryByTestId('typing-dialog')).toBeNull();
  });

  it('Android back invokes the latest onClose exactly once and leaves no stale interceptors behind', () => {
    const onClosed = vi.fn();
    render(<TypingDialog onClosed={onClosed} />);
    const details = screen.getByTestId('details');
    act(() => details.focus());
    typeInto(details, 'xyz');

    let handled = false;
    act(() => {
      handled = dispatchBackNavigation();
    });
    expect(handled).toBe(true);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenLastCalledWith('||xyz');
    expect(screen.queryByTestId('typing-dialog')).toBeNull();

    // No interceptor survives the close (none were re-registered per keystroke):
    // back now falls through to the route store, which is already at its root.
    act(() => {
      handled = dispatchBackNavigation();
    });
    expect(handled).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('re-runs initial focus when re-opened', () => {
    render(<TypingDialog onClosed={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('typing-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('reopen'));
    expect(document.activeElement).toBe(screen.getByTestId('email'));
  });
});
