import { getDatabase } from './db.mjs';

function nowIso() {
  return new Date().toISOString();
}

function safeLimit(value, fallback = 20) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(n)));
}

export function initializeDeadLetterStore() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS dead_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL UNIQUE,
      dedupe_key TEXT NOT NULL DEFAULT '',
      token_address TEXT NOT NULL DEFAULT '',
      pool_key TEXT NOT NULL DEFAULT '',
      job_type TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      final_error TEXT NOT NULL DEFAULT '',
      retry_count INTEGER NOT NULL DEFAULT 0,
      failed_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      replay_count INTEGER NOT NULL DEFAULT 0,
      last_replayed_at TEXT,
      resolved_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES jobs(job_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dead_letters_status_failed_at
      ON dead_letters(status, failed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dead_letters_token
      ON dead_letters(token_address, failed_at DESC);

    CREATE TRIGGER IF NOT EXISTS trg_jobs_to_dead_letter
    AFTER UPDATE OF status ON jobs
    WHEN NEW.status = 'FAILED' AND OLD.status <> 'FAILED'
    BEGIN
      INSERT INTO dead_letters (
        job_id, dedupe_key, token_address, pool_key, job_type, payload,
        final_error, retry_count, failed_at, status, replay_count,
        last_replayed_at, resolved_at, updated_at
      ) VALUES (
        NEW.job_id, NEW.dedupe_key, NEW.token_address, NEW.pool_key, NEW.job_type, NEW.payload,
        NEW.last_error, NEW.retry_count, COALESCE(NEW.finished_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        'OPEN', 0, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      )
      ON CONFLICT(job_id) DO UPDATE SET
        dedupe_key = excluded.dedupe_key,
        token_address = excluded.token_address,
        pool_key = excluded.pool_key,
        job_type = excluded.job_type,
        payload = excluded.payload,
        final_error = excluded.final_error,
        retry_count = excluded.retry_count,
        failed_at = excluded.failed_at,
        status = 'OPEN',
        resolved_at = NULL,
        updated_at = excluded.updated_at;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_jobs_dead_letter_requeued
    AFTER UPDATE OF status ON jobs
    WHEN OLD.status = 'FAILED' AND NEW.status = 'PENDING'
    BEGIN
      UPDATE dead_letters
      SET status = 'REQUEUED',
          replay_count = replay_count + 1,
          last_replayed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          resolved_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE job_id = NEW.job_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_jobs_dead_letter_resolved
    AFTER UPDATE OF status ON jobs
    WHEN NEW.status = 'DONE' AND OLD.status <> 'DONE'
    BEGIN
      UPDATE dead_letters
      SET status = 'RESOLVED',
          resolved_at = COALESCE(NEW.finished_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE job_id = NEW.job_id;
    END;
  `);

  return getDeadLetterStats();
}

export function getDeadLetterStats() {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status='REQUEUED' THEN 1 ELSE 0 END) AS requeued,
      SUM(CASE WHEN status='RESOLVED' THEN 1 ELSE 0 END) AS resolved,
      MAX(failed_at) AS latest_failed_at
    FROM dead_letters
  `).get() || {};
  return {
    total: Number(row.total || 0),
    open: Number(row.open || 0),
    requeued: Number(row.requeued || 0),
    resolved: Number(row.resolved || 0),
    latestFailedAt: row.latest_failed_at || null,
  };
}

export function listDeadLetters({ limit = 20, status = '' } = {}) {
  const db = getDatabase();
  const n = safeLimit(limit);
  const normalizedStatus = String(status || '').trim().toUpperCase();
  if (normalizedStatus && !['OPEN', 'REQUEUED', 'RESOLVED'].includes(normalizedStatus)) {
    throw new Error(`invalid dead-letter status: ${status}`);
  }
  const rows = normalizedStatus
    ? db.prepare(`
        SELECT * FROM dead_letters
        WHERE status = ?
        ORDER BY failed_at DESC, id DESC
        LIMIT ?
      `).all(normalizedStatus, n)
    : db.prepare(`
        SELECT * FROM dead_letters
        ORDER BY failed_at DESC, id DESC
        LIMIT ?
      `).all(n);
  return rows;
}

export function requeueFailedJob(jobId) {
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, jobId, reason: 'invalid_job_id' };
  }

  const db = getDatabase();
  const now = nowIso();
  return db.transaction(() => {
    const job = db.prepare(`
      SELECT job_id, token_address, job_type, status, retry_count, max_retries, last_error
      FROM jobs WHERE job_id = ?
    `).get(id);
    if (!job) return { ok: false, jobId: id, reason: 'job_not_found' };
    if (job.status !== 'FAILED') {
      return { ok: false, jobId: id, reason: 'job_not_failed', status: job.status };
    }

    const result = db.prepare(`
      UPDATE jobs
      SET status='PENDING', retry_count=0, last_error='', run_at=?,
          started_at=NULL, finished_at=NULL, updated_at=?
      WHERE job_id=? AND status='FAILED'
    `).run(now, now, id);

    if (!result.changes) {
      return { ok: false, jobId: id, reason: 'requeue_race' };
    }

    return {
      ok: true,
      jobId: id,
      token: job.token_address,
      type: job.job_type,
      previousRetryCount: Number(job.retry_count || 0),
      maxRetries: Number(job.max_retries || 0),
      runAt: now,
    };
  })();
}
