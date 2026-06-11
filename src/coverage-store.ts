/**
 * Durable coverage memory — SQLite + FTS5.
 *
 * Tracks which topics / clusters / fingerprints were processed in each cycle.
 * The Hermes agent-layer dark-launch gates (orchestrate.ts) query this store
 * to decide what an agent WOULD do; the deterministic conductor is unaffected.
 *
 * Two-stage dedup: FTS5 prefilter (topic full-text search) → exact-field confirm
 * (fingerprint equality). No model call required; a cheap model could be wired
 * as a third stage for semantic similarity later.
 *
 * Requires Node.js ≥ 22.5 with --experimental-sqlite (Node 24+ has it unflagged).
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

import type { SQLOutputValue } from 'node:sqlite';

/**
 * Distinct cycle_ids covering the same topic in recent history that marks the
 * topic as "exhausted" — i.e., the agent gate would flag it for angle refresh.
 */
const EXHAUSTION_THRESHOLD = 3;

export interface CoverageRecord {
  fingerprint: string;
  clusterId: string;
  topic: string;
  cycleId: string;
  publishedAt: string;
  articleSlug?: string;
  angle?: string;
}

export interface CoverageHit {
  fingerprint: string;
  clusterId: string;
  topic: string;
  cycleId: string;
  publishedAt: string;
  articleSlug: string;
  angle: string;
  matchType: 'fingerprint' | 'fts';
}

export interface CoverageResult {
  covered: boolean;
  hitCount: number;
  hits: CoverageHit[];
  /** True when the topic appears in ≥ EXHAUSTION_THRESHOLD distinct recent cycles. */
  exhausted: boolean;
}

export class CoverageStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this._init();
  }

  private _init(): void {
    this.db.exec(`
      PRAGMA journal_mode=WAL;

      CREATE TABLE IF NOT EXISTS coverage (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint  TEXT    NOT NULL,
        cluster_id   TEXT    NOT NULL,
        topic        TEXT    NOT NULL,
        cycle_id     TEXT    NOT NULL,
        published_at TEXT    NOT NULL,
        article_slug TEXT    NOT NULL DEFAULT '',
        angle        TEXT    NOT NULL DEFAULT '',
        recorded_at  TEXT    NOT NULL DEFAULT '',
        UNIQUE(fingerprint, cycle_id)
      );

      CREATE INDEX IF NOT EXISTS idx_cov_fp    ON coverage(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_cov_topic ON coverage(topic);
      CREATE INDEX IF NOT EXISTS idx_cov_cycle ON coverage(cycle_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS coverage_fts USING fts5(
        topic, article_slug, angle,
        content='coverage',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS coverage_ai AFTER INSERT ON coverage BEGIN
        INSERT INTO coverage_fts(rowid, topic, article_slug, angle)
          VALUES (new.id, new.topic, new.article_slug, new.angle);
      END;

      CREATE TRIGGER IF NOT EXISTS coverage_ad AFTER DELETE ON coverage BEGIN
        INSERT INTO coverage_fts(coverage_fts, rowid, topic, article_slug, angle)
          VALUES ('delete', old.id, old.topic, old.article_slug, old.angle);
      END;

      CREATE TABLE IF NOT EXISTS state_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  /** Record one cluster/article into coverage. UNIQUE(fingerprint, cycle_id) — idempotent. */
  record(rec: CoverageRecord, nowIso: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO coverage
           (fingerprint, cluster_id, topic, cycle_id, published_at, article_slug, angle, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.fingerprint,
        rec.clusterId,
        rec.topic,
        rec.cycleId,
        rec.publishedAt,
        rec.articleSlug ?? '',
        rec.angle ?? '',
        nowIso,
      );
  }

  /**
   * Two-stage coverage check:
   *   Stage 1 — exact fingerprint match (fast, indexed).
   *   Stage 2 — FTS5 topic search when no fingerprint hit and a topic is given.
   */
  check(query: { fingerprint?: string; topic?: string }): CoverageResult {
    const hits: CoverageHit[] = [];

    if (query.fingerprint) {
      const rows = this.db
        .prepare(
          `SELECT fingerprint, cluster_id, topic, cycle_id, published_at, article_slug, angle
           FROM coverage WHERE fingerprint = ?
           ORDER BY published_at DESC LIMIT 20`,
        )
        .all(query.fingerprint);
      for (const r of rows) {
        hits.push(rowToHit(r, 'fingerprint'));
      }
    }

    if (query.topic && hits.length === 0) {
      const ftsQ = buildFtsQuery(query.topic);
      if (ftsQ) {
        try {
          const rows = this.db
            .prepare(
              `SELECT c.fingerprint, c.cluster_id, c.topic, c.cycle_id,
                      c.published_at, c.article_slug, c.angle
               FROM coverage_fts
               JOIN coverage c ON coverage_fts.rowid = c.id
               WHERE coverage_fts MATCH ?
               ORDER BY c.published_at DESC LIMIT 20`,
            )
            .all(ftsQ);
          for (const r of rows) {
            const fp = String(r['fingerprint'] ?? '');
            if (!hits.some((h) => h.fingerprint === fp)) {
              hits.push(rowToHit(r, 'fts'));
            }
          }
        } catch {
          // Malformed FTS5 query → treat as no match; don't surface to caller
        }
      }
    }

    return {
      covered: hits.length > 0,
      hitCount: hits.length,
      hits,
      exhausted: this._isExhausted(query.topic ?? ''),
    };
  }

  private _isExhausted(topic: string): boolean {
    if (!topic) return false;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT cycle_id FROM coverage
         WHERE topic = ?
         ORDER BY published_at DESC LIMIT ?`,
      )
      .all(topic, EXHAUSTION_THRESHOLD);
    return rows.length >= EXHAUSTION_THRESHOLD;
  }

  /** Read a named cursor from the `state_meta` table (returns null if absent). */
  getCursor(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM state_meta WHERE key = ?`).get(key);
    return row ? String(row['value'] ?? '') : null;
  }

  /** Upsert a named cursor. */
  setCursor(key: string, value: string, nowIso: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO state_meta (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(key, value, nowIso);
  }

  close(): void {
    this.db.close();
  }
}

/** Open (or create) a `CoverageStore` at `<artifactStore>/coverage.db`. */
export function openCoverageStore(artifactStore: string): CoverageStore {
  return new CoverageStore(join(artifactStore, 'coverage.db'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SqlRow = Record<string, SQLOutputValue>;

function rowToHit(r: SqlRow, matchType: CoverageHit['matchType']): CoverageHit {
  return {
    fingerprint: String(r['fingerprint'] ?? ''),
    clusterId: String(r['cluster_id'] ?? ''),
    topic: String(r['topic'] ?? ''),
    cycleId: String(r['cycle_id'] ?? ''),
    publishedAt: String(r['published_at'] ?? ''),
    articleSlug: String(r['article_slug'] ?? ''),
    angle: String(r['angle'] ?? ''),
    matchType,
  };
}

/** Sanitize a raw term into a safe FTS5 MATCH clause on the `topic` column. */
function buildFtsQuery(raw: string): string {
  const cleaned = raw
    .replace(/["'*^(){}|,.:!\-+\\]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!cleaned) return '';
  return `topic: "${cleaned}"`;
}
