/** `follow_up_threads` repository. */
import type { FollowUpMessage, Id, TokenUsage } from '@kotori/core';
import type { Database } from '../sqlite';
import { all, num, one, opt, run } from './util';

export class ThreadRepository {
  constructor(private readonly db: Database) {}

  list(explanationId: Id): FollowUpMessage[] {
    return all(this.db, 'SELECT * FROM follow_up_threads WHERE explanation_id = ? ORDER BY seq', explanationId).map((r) => ({
      id: String(r['message_id']),
      role: String(r['role']) as FollowUpMessage['role'],
      text: String(r['text']),
      createdAt: num(r['created_at']),
      ...opt('usage', r['usage_json'] === null || r['usage_json'] === undefined ? undefined : (JSON.parse(String(r['usage_json'])) as TokenUsage)),
    }));
  }

  append(explanationId: Id, message: FollowUpMessage): void {
    const next = num(one(this.db, 'SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM follow_up_threads WHERE explanation_id = ?', explanationId)?.['n'] ?? 0);
    run(
      this.db,
      'INSERT INTO follow_up_threads (explanation_id, seq, message_id, role, text, usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      explanationId,
      next,
      message.id,
      message.role,
      message.text,
      message.usage ? JSON.stringify(message.usage) : null,
      message.createdAt,
    );
  }

  clear(explanationId?: Id): number {
    return explanationId === undefined
      ? run(this.db, 'DELETE FROM follow_up_threads').changes
      : run(this.db, 'DELETE FROM follow_up_threads WHERE explanation_id = ?', explanationId).changes;
  }
}
