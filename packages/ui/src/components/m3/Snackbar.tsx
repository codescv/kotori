/** Snackbar host: shows the head of the snackbar queue, auto-dismiss after 4 s. */
import { useEffect } from 'react';
import { useSnackbarStore } from '../../stores/snackbar';
import { cx } from './cx';
import { IconButton } from './IconButton';

export function SnackbarHost() {
  const head = useSnackbarStore((s) => s.queue[0]);
  const dismiss = useSnackbarStore((s) => s.dismiss);
  useEffect(() => {
    if (!head) return;
    const timer = setTimeout(() => dismiss(head.id), head.action ? 6000 : 4000);
    return () => clearTimeout(timer);
  }, [head, dismiss]);
  if (!head) return null;
  return (
    <div className={cx('k-snackbar', `k-snackbar--${head.tone}`)} role="status" aria-live="polite">
      <span className="k-snackbar__text">{head.text}</span>
      {head.action && (
        <button
          type="button"
          className="k-snackbar__action"
          onClick={() => {
            head.action?.run();
            dismiss(head.id);
          }}
        >
          {head.action.label}
        </button>
      )}
      <IconButton icon="close" label="dismiss" size="small" onClick={() => dismiss(head.id)} />
    </div>
  );
}
