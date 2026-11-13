/**
 * ==========================================================================
 * DATABASE MIGRATOR & TRACKER (`src/db/migrator.js`)
 * Transactional, fail-fast migration runner with manifest checksum verification,
 * PostgreSQL advisory lock concurrency protection, and rigorous schema evidence
 * verification for foundation bootstrap auto-detection.
 * ==========================================================================
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getPool, getClient } = require("./pool");
const { sanitizeMessage, formatSafeDbError } = require("./errors");

const DEFAULT_MANIFEST_PATH = path.resolve(__dirname, "../../database/manifest.json");

/**
 * Deterministic 32-bit positive integer for PostgreSQL session advisory lock.
 * Prevents concurrent migration runs from executing against the same database.
 */
const MIGRATION_ADVISORY_LOCK_ID = 742910482;

/**
 * Anchor tables required across all core business domains to conclusively prove
 * that a complete foundation exists before bootstrap auto-detection is allowed.
 */
const REQUIRED_ANCHOR_TABLES = [
  "users",
  "roles",
  "permissions",
  "user_roles",
  "products",
  "product_categories",
  "product_images",
  "portfolio_designs",
  "services",
  "service_addons",
  "service_areas",
  "orders",
  "order_items",
  "bookings",
  "payments",
  "business_settings",
  "faqs",
];

/**
 * Computes uppercase SHA-256 checksum of a file or string.
 * @param {string} content
 * @returns {string} 64-character uppercase hex hash
 */
function computeSha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").toUpperCase();
}

/**
 * Reads and validates database/manifest.json.
 * @param {string} [manifestPath]
 * @returns {object} Parsed manifest
 */
function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Migration manifest not found at: ${manifestPath}`);
  }
  const raw = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);

  if (!manifest.migrations || !Array.isArray(manifest.migrations)) {
    throw new Error(`Manifest missing valid 'migrations' array.`);
  }

  return manifest;
}

/**
 * Ensures the schema_migrations tracking table exists.
 * @param {import("pg").PoolClient | import("pg").Pool} client
 */
async function ensureMigrationTable(client) {
  const ddl = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      checksum VARCHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      execution_time_ms INTEGER NOT NULL,
      manifest_version VARCHAR(50)
    );
  `;
  await client.query(ddl);
}

/**
 * Acquires a PostgreSQL session advisory lock. Fails fast if another migration runner
 * is currently executing against the database.
 *
 * @param {import("pg").PoolClient} client
 */
async function acquireAdvisoryLock(client) {
  const res = await client.query("SELECT pg_try_advisory_lock($1) AS locked;", [MIGRATION_ADVISORY_LOCK_ID]);
  const acquired = res.rows[0].locked;
  if (!acquired) {
    throw new Error(
      `Concurrent migration in progress! Could not acquire advisory lock ${MIGRATION_ADVISORY_LOCK_ID}. Aborting to prevent race condition.`
    );
  }
}

/**
 * Releases the PostgreSQL session advisory lock.
 *
 * @param {import("pg").PoolClient} client
 */
async function releaseAdvisoryLock(client) {
  try {
    await client.query("SELECT pg_advisory_unlock($1);", [MIGRATION_ADVISORY_LOCK_ID]);
  } catch (err) {
    console.error("⚠️  [Migrator Warning] Failed to release advisory lock:", sanitizeMessage(err.message));
  }
}

/**
 * Inspects the target database schema evidence to distinguish between:
 * 1. "EMPTY": Clean database with 0 user tables.
 * 2. "COMPLETE_FOUNDATION": Full foundation present (50+ tables, all domain anchors verified).
 * 3. "PARTIAL_FOUNDATION": Fragmented state (1-49 tables, or missing anchor tables).
 *
 * @param {import("pg").PoolClient | import("pg").Pool} client
 * @param {number} [expectedTableCount=50]
 * @returns {Promise<{ state: "EMPTY" | "COMPLETE_FOUNDATION" | "PARTIAL_FOUNDATION", totalTables: number, missingAnchors: string[] }>}
 */
async function checkExistingFoundation(client, expectedTableCount = 50) {
  // 1. Count all non-migration user base tables in public schema
  const countSql = `
    SELECT COUNT(*) AS total
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name != 'schema_migrations';
  `;
  const countRes = await client.query(countSql);
  const totalTables = parseInt(countRes.rows[0].total, 10);

  if (totalTables === 0) {
    return { state: "EMPTY", totalTables: 0, missingAnchors: [] };
  }

  // 2. Query for presence of domain anchor tables
  const anchorSql = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name = ANY($1::text[]);
  `;
  const anchorRes = await client.query(anchorSql, [REQUIRED_ANCHOR_TABLES]);
  const existingAnchors = new Set(anchorRes.rows.map((r) => r.table_name));
  const missingAnchors = REQUIRED_ANCHOR_TABLES.filter((name) => !existingAnchors.has(name));

  // 3. Strict schema evidence evaluation
  if (totalTables >= expectedTableCount && missingAnchors.length === 0) {
    return { state: "COMPLETE_FOUNDATION", totalTables, missingAnchors: [] };
  }

  return { state: "PARTIAL_FOUNDATION", totalTables, missingAnchors };
}

/**
 * Retrieves the current migration status by inspecting manifest.json and schema_migrations.
 * Safely auto-registers pre-existing complete foundations without re-running DDL.
 *
 * @param {object} [options]
 * @param {string} [options.manifestPath]
 * @returns {Promise<{ manifestVersion: string, migrations: Array<{ id: string, name: string, status: "APPLIED" | "PENDING", appliedAt: string | null, checksum: string, recordedChecksum: string | null, executionTimeMs: number | null }> }>}
 */
async function getMigrationStatus(options = {}) {
  const manifest = loadManifest(options.manifestPath);
  const client = await getClient();

  try {
    await ensureMigrationTable(client);

    const historyRes = await client.query(
      `SELECT id, name, checksum, applied_at, execution_time_ms, manifest_version FROM schema_migrations ORDER BY id ASC;`
    );
    const historyMap = new Map(historyRes.rows.map((row) => [row.name, row]));

    // Check if initial migration should be bootstrap-registered
    const initialMigration = manifest.migrations.find((m) => m.id === "001" || m.name === "001_initial_schema");
    if (initialMigration && !historyMap.has(initialMigration.name)) {
      const foundation = await checkExistingFoundation(client, initialMigration.table_count || 50);

      if (foundation.state === "COMPLETE_FOUNDATION") {
        console.log(`ℹ️  [Migrator] Verified complete database foundation (${foundation.totalTables} tables). Bootstrap-recording ${initialMigration.name}...`);
        await client.query("BEGIN;");
        await client.query(
          `INSERT INTO schema_migrations (id, name, checksum, execution_time_ms, manifest_version)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING;`,
          [initialMigration.id, initialMigration.name, initialMigration.sha256, 0, manifest.version]
        );
        await client.query("COMMIT;");

        historyMap.set(initialMigration.name, {
          id: initialMigration.id,
          name: initialMigration.name,
          checksum: initialMigration.sha256,
          applied_at: new Date().toISOString(),
          execution_time_ms: 0,
          manifest_version: manifest.version,
        });
      } else if (foundation.state === "PARTIAL_FOUNDATION") {
        console.warn(
          `⚠️  [Migrator Warning] Database contains ${foundation.totalTables} tables, but does not match complete foundation (missing anchors: ${foundation.missingAnchors.join(", ")}). Migration "${initialMigration.name}" will remain PENDING.`
        );
      }
    }

    const migrationsStatus = manifest.migrations.map((m) => {
      const record = historyMap.get(m.name);
      return {
        id: m.id,
        name: m.name,
        status: record ? "APPLIED" : "PENDING",
        appliedAt: record ? record.applied_at : null,
        checksum: m.sha256,
        recordedChecksum: record ? record.checksum : null,
        executionTimeMs: record ? record.execution_time_ms : null,
        description: m.description,
      };
    });

    return {
      manifestVersion: manifest.version,
      migrations: migrationsStatus,
    };
  } finally {
    client.release();
  }
}

/**
 * Executes all pending migrations in strict manifest order.
 * - Guarded by PostgreSQL advisory locks against concurrent execution.
 * - Each migration runs in an isolated transaction (BEGIN / COMMIT / ROLLBACK).
 * - Fails fast if any statement fails or if a checksum mismatch is detected.
 * - Safely avoids re-running already applied migrations.
 * - Prevents executing initial schema against a partially created database without manual review.
 *
 * @param {object} [options]
 * @param {string} [options.manifestPath]
 * @returns {Promise<{ success: boolean, applied: string[], skipped: string[], total: number }>}
 */
async function runMigrations(options = {}) {
  const manifestPath = options.manifestPath || DEFAULT_MANIFEST_PATH;
  const manifestDir = path.dirname(manifestPath);
  const manifest = loadManifest(manifestPath);

  const client = await getClient();
  let lockAcquired = false;
  const applied = [];
  const skipped = [];

  try {
    // 1. Acquire advisory lock to prevent concurrent migration attempts
    await acquireAdvisoryLock(client);
    lockAcquired = true;

    // 2. Ensure migration tracking table exists
    await ensureMigrationTable(client);

    // 3. Fetch applied migration history
    const historyRes = await client.query(`SELECT id, name, checksum FROM schema_migrations;`);
    const historyMap = new Map(historyRes.rows.map((r) => [r.name, r]));

    // 4. Inspect existing schema evidence
    const initialMigration = manifest.migrations.find((m) => m.id === "001" || m.name === "001_initial_schema");
    const expectedCount = initialMigration ? initialMigration.table_count || 50 : 50;
    const foundation = await checkExistingFoundation(client, expectedCount);

    for (const migration of manifest.migrations) {
      if (historyMap.has(migration.name)) {
        const recorded = historyMap.get(migration.name);
        if (recorded.checksum && migration.sha256 && recorded.checksum !== migration.sha256) {
          console.warn(
            `⚠️  [Migrator Checksum Mismatch] Recorded checksum for applied migration "${migration.name}" (${recorded.checksum}) differs from manifest (${migration.sha256}).`
          );
        }
        skipped.push(migration.name);
        continue;
      }

      // Check if this is the initial schema and a foundation already exists
      if (migration.name === "001_initial_schema") {
        if (foundation.state === "COMPLETE_FOUNDATION") {
          console.log(`ℹ️  [Migrator] Recognized complete foundation (${foundation.totalTables} tables). Bootstrap-recording ${migration.name} without re-running DDL.`);
          await client.query("BEGIN;");
          await client.query(
            `INSERT INTO schema_migrations (id, name, checksum, execution_time_ms, manifest_version)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO NOTHING;`,
            [migration.id, migration.name, migration.sha256, 0, manifest.version]
          );
          await client.query("COMMIT;");
          applied.push(`${migration.name} (bootstrap-registered)`);
          continue;
        }

        if (foundation.state === "PARTIAL_FOUNDATION") {
          throw new Error(
            `Partially created database detected (${foundation.totalTables}/${expectedCount} tables, missing anchors: ${foundation.missingAnchors.join(", ")}). ` +
            `Cannot safely apply or bootstrap "${migration.name}". Aborting to prevent schema corruption. Manual review required.`
          );
        }
      }

      // Read migration file
      const upFilePath = path.resolve(manifestDir, migration.up_file);
      if (!fs.existsSync(upFilePath)) {
        throw new Error(`Migration file not found: "${upFilePath}"`);
      }

      const sqlContent = fs.readFileSync(upFilePath, "utf8");
      const diskChecksum = computeSha256(sqlContent);

      // Verify file integrity against manifest
      if (migration.sha256 && diskChecksum !== migration.sha256) {
        throw new Error(
          `Integrity checksum mismatch for "${migration.name}"!\n` +
          `Expected: ${migration.sha256}\n` +
          `Actual:   ${diskChecksum}\n` +
          `Execution aborted to prevent applying corrupted migration.`
        );
      }

      console.log(`⚡ [Migrator] Applying migration: ${migration.name}...`);
      const startTime = Date.now();

      // Transactional fail-fast execution
      try {
        await client.query("BEGIN;");
        await client.query(sqlContent);
        const durationMs = Date.now() - startTime;

        await client.query(
          `INSERT INTO schema_migrations (id, name, checksum, execution_time_ms, manifest_version)
           VALUES ($1, $2, $3, $4, $5);`,
          [migration.id, migration.name, diskChecksum, durationMs, manifest.version]
        );

        await client.query("COMMIT;");
        console.log(`✅ [Migrator] Successfully applied ${migration.name} (${durationMs}ms)`);
        applied.push(migration.name);
      } catch (err) {
        await client.query("ROLLBACK;");
        const safe = formatSafeDbError(err, `Migration ${migration.name}`);
        console.error(`❌ [Migrator Failed] ${safe.safeDetails}`);
        throw new Error(`Migration "${migration.name}" failed: ${safe.clientMessage}`);
      }
    }

    return {
      success: true,
      applied,
      skipped,
      total: manifest.migrations.length,
    };
  } finally {
    if (lockAcquired) {
      await releaseAdvisoryLock(client);
    }
    client.release();
  }
}

module.exports = {
  computeSha256,
  loadManifest,
  ensureMigrationTable,
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  checkExistingFoundation,
  getMigrationStatus,
  runMigrations,
  REQUIRED_ANCHOR_TABLES,
};
