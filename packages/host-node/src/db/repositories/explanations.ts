/** `explanations` repository — the persistent explanation cache (keyed by `SentenceExplanation.id`). */
import type { Id, SentenceExplanation } from '@kotori/core';
import type { Database } from '../sqlite';
import { all, num, one, run } from './util';

/** Max bound parameters per `IN (...)` query (well under SQLite's 999 / 32766 limits). */
export const HAS_MANY_CHUNK = 200;

export class ExplanationRepository {
  /** Small in-memory front cache so repeated hits resolve well under 5 ms. */
  private readonly hot = new Map<Id, SentenceExplanation>();
  private static readonly HOT_MAX = 256;

  constructor(private readonly db: Database) {}

  get(id: Id): SentenceExplanation | undefined {
    const cached = this.hot.get(id);
    if (cached) {
      // Refresh recency so eviction is least-recently-used.
      this.hot.delete(id);
      this.hot.set(id, cached);
      return { ...cached };
    }
    const r = one(this.db, 'SELECT json FROM explanations WHERE id = ?', id);
    if (!r) return undefined;
    const expl = JSON.parse(String(r['json'])) as SentenceExplanation;
    this.remember(expl);
    return { ...expl };
  }

  put(expl: SentenceExplanation): void {
    const stored: SentenceExplanation = { ...expl, fromCache: false };
    run(
      this.db,
      `INSERT INTO explanations (id, sentence, target_language, model, prompt_version, json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at`,
      stored.id,
      stored.sentence,
      stored.targetLanguage,
      stored.model,
      stored.promptVersion,
      JSON.stringify(stored),
      stored.createdAt,
    );
    this.remember(stored);
  }

  /**
   * Subset of `ids` that are cached — one parameterised `IN (?, …)` query per
   * {@link HAS_MANY_CHUNK} ids (hot entries answered from memory first).
   */
  hasMany(ids: readonly Id[]): Set<Id> {
    const found = new Set<Id>();
    const pending: Id[] = [];
    for (const id of new Set(ids)) {
      if (typeof id !== 'string') continue;
      if (this.hot.has(id)) found.add(id);
      else pending.push(id);
    }
    for (let i = 0; i < pending.length; i += HAS_MANY_CHUNK) {
      const chunk = pending.slice(i, i + HAS_MANY_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      for (const row of all(this.db, `SELECT id FROM explanations WHERE id IN (${placeholders})`, ...chunk)) {
        found.add(String(row['id']));
      }
    }
    return found;
  }

  count(): number {
    return num(one(this.db, 'SELECT COUNT(*) AS n FROM explanations')?.['n'] ?? 0);
  }

  /** Delete every cached explanation (and their threads); returns rows removed. */
  clear(): number {
    const removed = run(this.db, 'DELETE FROM explanations').changes;
    run(this.db, 'DELETE FROM follow_up_threads');
    this.hot.clear();
    return removed;
  }

  private remember(expl: SentenceExplanation): void {
    this.hot.delete(expl.id);
    this.hot.set(expl.id, expl);
    if (this.hot.size > ExplanationRepository.HOT_MAX) {
      const oldest = this.hot.keys().next().value;
      if (oldest !== undefined) this.hot.delete(oldest);
    }
  }
}
