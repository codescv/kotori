/**
 * Follow-up Q&A under an explanation: preset question chips, the persisted
 * thread, a live streaming bubble, and an input. Streaming vs single-shot is
 * decided by the store (`capabilities.streaming`).
 */
import { useEffect, useRef, useState } from 'react';
import type { FollowUpMessage } from '@kotori/core';
import type { MessageKey, Translate } from '../../i18n';
import { Chip } from '../m3/Chip';
import { cx } from '../m3/cx';
import { IconButton } from '../m3/IconButton';
import { TextField } from '../m3/TextField';

export interface FollowUpThreadProps {
  readonly thread: readonly FollowUpMessage[];
  readonly streamingText?: string | undefined;
  readonly pending: boolean;
  readonly onAsk: (question: string) => void;
  readonly t: Translate;
}

const SUGGESTIONS: readonly MessageKey[] = ['followup.suggest.why', 'followup.suggest.polite', 'followup.suggest.examples', 'followup.suggest.nuance'];

/** Tiny markdown-light renderer: **bold**, `code`, line breaks (no HTML injection). */
export function renderLight(text: string) {
  return text.split('\n').map((line, li) => (
    <span key={li} className="k-md-line">
      {line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, pi) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={pi}>{part.slice(2, -2)}</strong>;
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={pi}>{part.slice(1, -1)}</code>;
        return <span key={pi}>{part}</span>;
      })}
    </span>
  ));
}

export function FollowUpThread({ thread, streamingText, pending, onAsk, t }: FollowUpThreadProps) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [thread.length, streamingText]);
  const submit = (q: string): void => {
    if (!q.trim() || pending) return;
    onAsk(q.trim());
    setDraft('');
  };
  return (
    <section className="k-followup" aria-label={t('followup.title')}>
      <div className="k-followup__suggestions">
        {SUGGESTIONS.map((key) => (
          <Chip key={key} kind="suggestion" disabled={pending} onClick={() => submit(t(key))}>
            {t(key)}
          </Chip>
        ))}
      </div>
      <div className="k-followup__messages">
        {thread.map((m) => (
          <div key={m.id} className={cx('k-msg', `k-msg--${m.role}`)} data-testid={`msg-${m.role}`}>
            {renderLight(m.text)}
          </div>
        ))}
        {pending && (
          <div className="k-msg k-msg--model is-streaming" data-testid="msg-streaming">
            {streamingText ? renderLight(streamingText) : <span className="k-muted">{t('followup.thinking')}</span>}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <form
        className="k-followup__input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <TextField
          label={t('followup.placeholder')}
          value={draft}
          onValueChange={setDraft}
          disabled={pending}
          trailing={<IconButton icon="send" label={t('followup.send')} type="submit" disabled={pending || !draft.trim()} />}
        />
      </form>
    </section>
  );
}
