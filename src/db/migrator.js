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
const { getClient } = require("./pool");
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
 * Computes the manifest checksum using repository (LF) line endings.
 * @param {string} content
 * @returns {string} 64-character uppercase hex hash
 */
function computeSha256(content) {
  return crypto.createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex").toUpperCase();
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
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
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

async function readMigrationHistory(client) {
  const result = await client.query("SELECT to_regclass('public.schema_migrations') AS ledger");
  if (!result.rows[0].ledger) return new Map();

  const history = await client.query("SELECT * FROM public.schema_migrations ORDER BY id");
  return new Map(history.rows.map((row) => [row.name, row]));
}

async function hasExistingTable(client, migration) {
  if (!migration.existing_table) return false;
  const result = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [
    `public.${migration.existing_table}`,
  ]);
  return result.rows[0].present;
}

/** Reports ledger and schema evidence without creating tables or recording migrations. */
async function getMigrationStatus(options = {}) {
  const manifest = loadManifest(options.manifestPath);
  const client = await getClient();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const history = await readMigrationHistory(client);
    const migrations = [];
    for (const migration of manifest.migrations) {
      const record = history.get(migration.name);
      let status = migration.status === "BASELINE" ? "PENDING" : "APPROVAL_REQUIRED";
      if (record) {
        status = "APPLIED";
      } else if (await hasExistingTable(client, migration)) {
        status = "PRESENT_UNRECORDED";
      } else if (migration.id === "001") {
        const foundation = await checkExistingFoundation(client, migration.table_count);
        if (foundation.state === "COMPLETE_FOUNDATION") status = "PRESENT_UNRECORDED";
      }
      migrations.push({
        id: migration.id,
        name: migration.name,
        status,
        appliedAt: record?.applied_at ?? null,
        checksum: migration.sha256,
        recordedChecksum: record?.checksum ?? null,
        executionTimeMs: record?.execution_time_ms ?? null,
        description: migration.description,
      });
    }
    await client.query("COMMIT");
    return { manifestVersion: manifest.version, migrations };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies the baseline or one explicitly named pending migration.
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
  const baseline = manifest.migrations.filter((m) => m.status === "BASELINE");
  const approved = options.approve && manifest.migrations.find(
    (m) => m.name === options.approve && m.status === "AUTHORED_PENDING_APPROVAL"
  );
  if (options.approve !== undefined && !approved) {
    throw new Error("Approval must name one pending migration exactly.");
  }
  const selected = approved ? [approved] : baseline;

  const client = await getClient();
  let lockAcquired = false;
  const applied = [];
  const skipped = [];

  try {
    // 1. Acquire advisory lock to prevent concurrent migration attempts
    await acquireAdvisoryLock(client);
    lockAcquired = true;

    const historyMap = await readMigrationHistory(client);
    if (approved && !historyMap.has(approved.name)) {
      if (await hasExistingTable(client, approved)) {
        throw new Error(`${approved.name} has existing schema without a ledger record. Review it before applying or recording the migration.`);
      }
      if (baseline.some((m) => !historyMap.has(m.name))) {
        throw new Error("The baseline migrations must be recorded before applying a named migration.");
      }
    }
    if (!approved && !selected.every((m) => historyMap.has(m.name))) {
      await ensureMigrationTable(client);
    }

    for (const migration of selected) {
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
        const foundation = await checkExistingFoundation(client, migration.table_count);
        if (foundation.state === "COMPLETE_FOUNDATION") {
          console.log(`ℹ️  [Migrator] Recognized complete foundation (${foundation.totalTables} tables). Bootstrap-recording ${migration.name} without re-running DDL.`);
          await client.query("BEGIN;");
          await client.query(
            `INSERT INTO public.schema_migrations (id, name, checksum, execution_time_ms, manifest_version)
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

      const sqlContent = fs.readFileSync(upFilePath, "utf8").replace(/\r\n/g, "\n");
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
        // The ledger insert must commit with the SQL, including files runnable standalone.
        const statements = sqlContent.replace(/^BEGIN;[ \t]*$/m, "").replace(/^COMMIT;\s*$/m, "");
        await client.query(statements);
        const durationMs = Date.now() - startTime;

        await client.query(
          `INSERT INTO public.schema_migrations (id, name, checksum, execution_time_ms, manifest_version)
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
      total: selected.length,
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
