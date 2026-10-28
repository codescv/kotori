/**
 * Follow-up Q&A under an explanation: preset question chips, the persisted
 * thread, a live streaming bubble, and an input. Streaming vs single-shot is
 * decided by the store (`capabilities.streaming`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
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

const INLINE_RE = /(\*\*[^*]+?\*\*|`[^`]+`)/g;
/** Unordered bullet markers Gemini emits (`* `, `- `, `• `). */
const BULLET_RE = /^\s*[*\-•]\s+/;
const HEADING_RE = /^\s*#{1,6}\s+/;

/** Inline spans: **bold** (may itself contain `code`) and `code`; no HTML injection. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split(INLINE_RE)
    .filter((part) => part !== '')
    .map((part, i) => {
      const key = `${keyPrefix}-${i}`;
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={key}>{renderInline(part.slice(2, -2), key)}</strong>;
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={key}>{part.slice(1, -1)}</code>;
      return <span key={key}>{part}</span>;
    });
}

/**
 * Tiny markdown-light renderer: **bold**, `code` (also inside bold), `* ` /
 * `- ` bullet lists, `#` headings and line breaks (no HTML injection).
 */
export function renderLight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let bullets: ReactNode[] = [];
  const flush = (): void => {
    if (bullets.length === 0) return;
    out.push(
      <ul key={`ul-${out.length}`} className="k-md-list">
        {bullets}
      </ul>,
    );
    bullets = [];
  };
  text.split('\n').forEach((line, li) => {
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      bullets.push(<li key={li}>{renderInline(line.slice(bullet[0].length), `l${li}`)}</li>);
      return;
    }
    flush();
    const heading = HEADING_RE.exec(line);
    out.push(
      <span key={li} className={cx('k-md-line', heading && 'k-md-heading')}>
        {heading ? <strong>{renderInline(line.slice(heading[0].length), `l${li}`)}</strong> : renderInline(line, `l${li}`)}
      </span>,
    );
  });
  flush();
  return out;
}

export function FollowUpThread({ thread, streamingText, pending, onAsk, t }: FollowUpThreadProps) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  // Never scroll on mount (or when a persisted thread is restored right after
  // the panel opens): that pushed the sentence/translation off-screen. Only
  // follow the conversation once the user has asked something here.
  const askedRef = useRef(false);
  const prevLenRef = useRef(thread.length);
  useEffect(() => {
    const grew = thread.length > prevLenRef.current;
    prevLenRef.current = thread.length;
    if (!askedRef.current) return;
    if (grew || pending || (streamingText ?? '') !== '') {
      endRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
  }, [thread.length, streamingText, pending]);
  const submit = (q: string): void => {
    if (!q.trim() || pending) return;
    askedRef.current = true;
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
