/**
 * Regression coverage for the safety-valve fix shipped in v3.9.22.
 *
 * Pre-fix: `hardDeleteExcess` issued `DELETE FROM captured_experiences` and
 * destroyed ~16K rows in production. The fix replaces the DELETE with an
 * UPDATE that sets `consolidated_into = 'archived'`. These tests guard the
 * invariant that the safety valve is now strictly non-destructive.
 */
import Database from 'better-sqlite3';
import { ExperienceConsolidator } from '../../../src/learning/experience-consolidation.js';

interface RowCount { n: number }

function bootstrapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE captured_experiences (
      id TEXT PRIMARY KEY,
      task TEXT,
      agent TEXT,
      domain TEXT NOT NULL,
      success INTEGER DEFAULT 0,
      quality REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      model_tier TEXT,
      routing_json TEXT,
      steps_json TEXT,
      result_json TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      source TEXT,
      application_count INTEGER DEFAULT 0,
      avg_token_savings REAL DEFAULT 0,
      embedding BLOB,
      embedding_dimension INTEGER,
      tags TEXT,
      last_applied_at TEXT,
      consolidated_into TEXT DEFAULT NULL,
      consolidation_count INTEGER DEFAULT 1,
      quality_updated_at TEXT,
      reuse_success_count INTEGER DEFAULT 0,
      reuse_failure_count INTEGER DEFAULT 0
    );
    CREATE TABLE experience_consolidation_log (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      source_ids TEXT NOT NULL,
      target_id TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE experience_applications (
      id TEXT PRIMARY KEY,
      experience_id TEXT NOT NULL,
      task TEXT,
      success INTEGER DEFAULT 0,
      tokens_saved INTEGER DEFAULT 0,
      feedback TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function seedDomain(db: Database.Database, domain: string, count: number, quality = 0.3): void {
  const insert = db.prepare(`
    INSERT INTO captured_experiences
    (id, task, domain, quality, success, started_at, source)
    VALUES (?, ?, ?, ?, 1, ?, 'test')
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run(`exp-${domain}-${i}`, `task-${i}`, domain, quality, '2026-02-01 00:00:00');
    }
  });
  tx();
}

describe('ExperienceConsolidator safety valve (v3.9.22+)', () => {
  let db: Database.Database;
  let consolidator: ExperienceConsolidator;

  beforeEach(async () => {
    db = new Database(':memory:');
    bootstrapSchema(db);
    consolidator = new ExperienceConsolidator({
      // Tighten thresholds so we can exercise the valve with a small dataset
      hardThreshold: 50,
      softThreshold: 10,
      maxMergesPerRun: 0, // disable merge phase — isolate valve behavior
      archiveQualityThreshold: -1, // disable Phase 3 archive — isolate valve
    });
    await consolidator.initialize(db);
  });

  afterEach(() => {
    db.close();
  });

  it('never physically deletes rows when the safety valve fires', async () => {
    seedDomain(db, 'code-intelligence', 75);
    const before = (db.prepare('SELECT COUNT(*) as n FROM captured_experiences').get() as RowCount).n;
    expect(before).toBe(75);

    await consolidator.consolidateDomain('code-intelligence');

    const after = (db.prepare('SELECT COUNT(*) as n FROM captured_experiences').get() as RowCount).n;
    expect(after).toBe(75); // every row still physically present
  });

  it('soft-archives the excess so active count drops to hardThreshold', async () => {
    seedDomain(db, 'code-intelligence', 75);

    await consolidator.consolidateDomain('code-intelligence');

    const active = (db.prepare(
      "SELECT COUNT(*) as n FROM captured_experiences WHERE consolidated_into IS NULL"
    ).get() as RowCount).n;
    const archived = (db.prepare(
      "SELECT COUNT(*) as n FROM captured_experiences WHERE consolidated_into = 'archived'"
    ).get() as RowCount).n;

    expect(active).toBe(50); // == hardThreshold
    expect(archived).toBe(25); // 75 - 50
  });

  it('keeps statusline-formula count monotonic (NULL OR archived)', async () => {
    seedDomain(db, 'code-intelligence', 75);
    const formulaBefore = (db.prepare(
      "SELECT COUNT(*) as n FROM captured_experiences WHERE consolidated_into IS NULL OR consolidated_into = 'archived'"
    ).get() as RowCount).n;

    await consolidator.consolidateDomain('code-intelligence');

    const formulaAfter = (db.prepare(
      "SELECT COUNT(*) as n FROM captured_experiences WHERE consolidated_into IS NULL OR consolidated_into = 'archived'"
    ).get() as RowCount).n;

    expect(formulaAfter).toBeGreaterThanOrEqual(formulaBefore); // never drops
    expect(formulaAfter).toBe(75);
  });

  it('attributes the soft-archived count to result.archived, leaves hardDeleted at 0', async () => {
    seedDomain(db, 'code-intelligence', 75);

    const result = await consolidator.consolidateDomain('code-intelligence');

    expect(result.hardDeleted).toBe(0);
    expect(result.archived).toBeGreaterThanOrEqual(25);
  });

  it('writes a safety-valve audit entry to experience_consolidation_log', async () => {
    seedDomain(db, 'code-intelligence', 75);

    await consolidator.consolidateDomain('code-intelligence');

    const logged = db.prepare(
      "SELECT action, domain, details FROM experience_consolidation_log WHERE action = 'safety-valve-archive'"
    ).all() as Array<{ action: string; domain: string; details: string }>;

    expect(logged).toHaveLength(1);
    expect(logged[0].domain).toBe('code-intelligence');
    const parsed = JSON.parse(logged[0].details);
    expect(parsed.count).toBe(25);
    expect(parsed.hardThreshold).toBe(50);
  });

  it('is a no-op when domain is under the hard threshold', async () => {
    seedDomain(db, 'code-intelligence', 30); // under 50

    const result = await consolidator.consolidateDomain('code-intelligence');

    const archived = (db.prepare(
      "SELECT COUNT(*) as n FROM captured_experiences WHERE consolidated_into = 'archived'"
    ).get() as RowCount).n;
    expect(archived).toBe(0);
    expect(result.archived).toBe(0);
    expect(result.hardDeleted).toBe(0);
  });

  it('preserves rows with application_count > 0 even when valve fires', async () => {
    seedDomain(db, 'code-intelligence', 75);
    // Mark the 10 lowest-quality rows as "applied" — they should survive
    db.prepare(`
      UPDATE captured_experiences
      SET application_count = 5
      WHERE id IN (SELECT id FROM captured_experiences ORDER BY quality ASC LIMIT 10)
    `).run();

    await consolidator.consolidateDomain('code-intelligence');

    const appliedSurvived = (db.prepare(
      "SELECT COUNT(*) as n FROM captured_experiences WHERE application_count > 0 AND consolidated_into IS NULL"
    ).get() as RowCount).n;
    expect(appliedSurvived).toBe(10);
  });
});
