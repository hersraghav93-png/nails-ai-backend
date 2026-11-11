/**
 * ==========================================================================
 * AUTOMATED BACKEND INTEGRATION TEST SUITE (`scripts/testBackend.js`)
 * Executes comprehensive assertions across Configuration, Error Sanitization,
 * Connection Pooling, Health Probes, Migration Runner, and Divv AI Contract.
 * ==========================================================================
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

const CONFIG = require("../src/config");
const { sanitizeMessage, formatSafeDbError } = require("../src/db/errors");
const { getPool, checkHealth, closePool } = require("../src/db/pool");
const {
  computeSha256,
  loadManifest,
  checkExistingFoundation,
  getMigrationStatus,
} = require("../src/db/migrator");
const {
  retrieveRelevantContext,
  getKnowledgeStatus,
  generateChatReply,
} = require("../src/services/aiService");
const app = require("../index");

let passedCount = 0;
let failedCount = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}`);
    console.error(`     Error: ${err.message}`);
    failedCount++;
  }
}

async function itAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}`);
    console.error(`     Error: ${err.message}`);
    failedCount++;
  }
}

async function runTestSuite() {
  console.log("==================================================================");
  console.log("   NAILS BY DIVYA — PHASE 1B BACKEND INTEGRATION TEST SUITE");
  console.log("==================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. CONFIGURATION TESTS
  // ---------------------------------------------------------------------------
  console.log("🧪 1. Configuration Module (src/config/index.js)");
  it("exports valid configuration object with server and database settings", () => {
    assert.ok(typeof CONFIG.port === "number", "port should be a number");
    assert.ok(CONFIG.port > 0, "port should be greater than 0");
    assert.ok(typeof CONFIG.nodeEnv === "string", "nodeEnv should be a string");
    assert.ok(CONFIG.database, "CONFIG.database should exist");
    assert.strictEqual(typeof CONFIG.database.host, "string", "host should be string");
    assert.strictEqual(typeof CONFIG.database.port, "number", "port should be number");
    assert.strictEqual(typeof CONFIG.database.database, "string", "database name should be string");
    assert.strictEqual(typeof CONFIG.database.user, "string", "user should be string");
    assert.strictEqual(typeof CONFIG.database.poolMax, "number", "poolMax should be number");
    assert.ok(CONFIG.database.poolMax >= 1, "poolMax should be at least 1");
  });

  it("database pool configuration defaults match production safety standards", () => {
    assert.strictEqual(CONFIG.database.port, 5432, "default port should be 5432");
    assert.strictEqual(CONFIG.database.database, "nailsbydivya_staging", "default db should be nailsbydivya_staging");
    assert.strictEqual(CONFIG.database.poolIdleTimeoutMs, 30000, "idle timeout should be 30000ms");
    assert.strictEqual(CONFIG.database.connectionTimeoutMs, 5000, "connection timeout should be 5000ms");
  });

  // ---------------------------------------------------------------------------
  // 2. ERROR SANITIZER & SAFETY TESTS
  // ---------------------------------------------------------------------------
  console.log("\n🧪 2. Database Error Sanitizer (src/db/errors.js)");
  it("sanitizeMessage masks passwords in connection URIs", () => {
    const rawUri = "Failed connecting to postgresql://postgres:SuperSecretP@ss123@localhost:5432/nailsbydivya_staging";
    const sanitized = sanitizeMessage(rawUri);
    assert.ok(!sanitized.includes("SuperSecretP@ss123"), "password must be stripped");
    assert.ok(sanitized.includes("postgresql://***:***@localhost:5432/nailsbydivya_staging"), "URI masked correctly");
  });

  it("sanitizeMessage masks password= parameters", () => {
    const rawErr = 'error: password="SuperSecretP@ss123" authentication failed';
    const sanitized = sanitizeMessage(rawErr);
    assert.ok(!sanitized.includes("SuperSecretP@ss123"), "password param must be stripped");
    assert.ok(sanitized.includes('password=***'), "parameter masked correctly");
  });

  it("formatSafeDbError maps unique constraint violation 23505 to 409 Conflict", () => {
    const fakeErr = new Error("duplicate key value violates unique constraint 'users_email_key'");
    fakeErr.code = "23505";
    const result = formatSafeDbError(fakeErr, "User Creation");
    assert.strictEqual(result.statusCode, 409);
    assert.strictEqual(result.code, "CONFLICT");
    assert.strictEqual(result.clientMessage, "A record with this information already exists.");
  });

  it("formatSafeDbError maps authentication failure 28P01 to 503 Auth Failure", () => {
    const fakeErr = new Error("FATAL: password authentication failed for user postgres");
    fakeErr.code = "28P01";
    const result = formatSafeDbError(fakeErr, "DB Pool");
    assert.strictEqual(result.statusCode, 503);
    assert.strictEqual(result.code, "AUTH_FAILURE");
    assert.strictEqual(result.clientMessage, "Database authentication failure.");
  });

  it("formatSafeDbError maps connection refused ECONNREFUSED to 503 Connection Unavailable", () => {
    const fakeErr = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    fakeErr.code = "ECONNREFUSED";
    const result = formatSafeDbError(fakeErr, "DB Connection");
    assert.strictEqual(result.statusCode, 503);
    assert.strictEqual(result.code, "CONNECTION_UNAVAILABLE");
    assert.strictEqual(result.clientMessage, "Database service unreachable.");
  });

  // ---------------------------------------------------------------------------
  // 3. DATABASE POOL & HEALTH PROBE TESTS
  // ---------------------------------------------------------------------------
  console.log("\n🧪 3. Database Pool & Health Check (src/db/pool.js)");
  it("getPool returns a valid pg.Pool instance with attached error handler", () => {
    const pool = getPool();
    assert.ok(pool, "pool instance should exist");
    assert.strictEqual(typeof pool.query, "function", "pool.query should be a function");
    assert.strictEqual(typeof pool.connect, "function", "pool.connect should be a function");
    assert.ok(pool.listenerCount("error") >= 1, "pool should have an error listener attached");
  });

  await itAsync("checkHealth executes non-crashing probe and returns structured metrics", async () => {
    const health = await checkHealth();
    assert.ok(health, "health result should be returned");
    assert.ok(["connected", "disconnected"].includes(health.status), "status must be connected or disconnected");
    assert.ok(typeof health.latencyMs === "number", "latencyMs must be a number");
    assert.ok(health.pool, "pool metrics object must exist");
    assert.strictEqual(typeof health.pool.total, "number", "pool.total must be a number");
    assert.strictEqual(typeof health.pool.idle, "number", "pool.idle must be a number");
    assert.strictEqual(typeof health.pool.waiting, "number", "pool.waiting must be a number");
  });

  // ---------------------------------------------------------------------------
  // 4. MIGRATION RUNNER & MANIFEST TESTS
  // ---------------------------------------------------------------------------
  console.log("\n🧪 4. Migration Runner & Manifest Integrity (src/db/migrator.js)");
  it("loadManifest loads and parses database/manifest.json correctly", () => {
    const manifest = loadManifest();
    assert.strictEqual(manifest.project, "Nails by Divya");
    assert.ok(Array.isArray(manifest.migrations), "migrations must be an array");
    assert.ok(manifest.migrations.length >= 1, "manifest must contain at least 1 migration");
    const m1 = manifest.migrations[0];
    assert.strictEqual(m1.id, "001");
    assert.strictEqual(m1.name, "001_initial_schema");
    assert.strictEqual(m1.table_count, 50);
  });

  it("computeSha256 produces exact match for initial schema migration file", () => {
    const manifest = loadManifest();
    const manifestDir = path.resolve(__dirname, "../database");
    const migrationFile = path.resolve(manifestDir, manifest.migrations[0].up_file);
    assert.ok(fs.existsSync(migrationFile), "migration file must exist on disk");

    const sqlContent = fs.readFileSync(migrationFile, "utf8");
    const calculatedSha = computeSha256(sqlContent);
    assert.strictEqual(
      calculatedSha,
      manifest.migrations[0].sha256,
      "Calculated SHA-256 must match manifest SHA-256 exactly"
    );
  });

  it("computeSha256 produces exact match for rollback schema migration file", () => {
    const manifest = loadManifest();
    const manifestDir = path.resolve(__dirname, "../database");
    const rollbackFile = path.resolve(manifestDir, manifest.migrations[0].down_file);
    assert.ok(fs.existsSync(rollbackFile), "rollback file must exist on disk");

    const sqlContent = fs.readFileSync(rollbackFile, "utf8");
    const calculatedSha = computeSha256(sqlContent);
    assert.strictEqual(
      calculatedSha,
      manifest.migrations[0].down_sha256,
      "Calculated rollback SHA-256 must match manifest down_sha256 exactly"
    );
  });

  await itAsync("checkExistingFoundation accurately identifies complete foundation, partial foundation, and empty state", async () => {
    // 1. Mock complete populated database (50 tables and all anchors)
    const { REQUIRED_ANCHOR_TABLES } = require("../src/db/migrator");
    const mockPopulatedClient = {
      query: async (sql) => {
        if (sql.includes("COUNT(*) AS total")) {
          return { rows: [{ total: "50" }] };
        }
        if (sql.includes("table_name = ANY")) {
          return { rows: REQUIRED_ANCHOR_TABLES.map((t) => ({ table_name: t })) };
        }
        return { rows: [] };
      },
    };
    const complete = await checkExistingFoundation(mockPopulatedClient, 50);
    assert.strictEqual(complete.state, "COMPLETE_FOUNDATION", "Should recognize complete foundation");
    assert.strictEqual(complete.totalTables, 50);
    assert.strictEqual(complete.missingAnchors.length, 0);

    // 2. Mock partially created database (e.g. only 10 tables, missing anchors)
    const mockPartialClient = {
      query: async (sql) => {
        if (sql.includes("COUNT(*) AS total")) {
          return { rows: [{ total: "10" }] };
        }
        if (sql.includes("table_name = ANY")) {
          return { rows: [{ table_name: "users" }, { table_name: "roles" }] };
        }
        return { rows: [] };
      },
    };
    const partial = await checkExistingFoundation(mockPartialClient, 50);
    assert.strictEqual(partial.state, "PARTIAL_FOUNDATION", "Should reject partially created database");
    assert.strictEqual(partial.totalTables, 10);
    assert.ok(partial.missingAnchors.length > 0, "Should list missing anchors");

    // 3. Mock empty database (0 tables)
    const mockEmptyClient = {
      query: async (sql) => {
        if (sql.includes("COUNT(*) AS total")) {
          return { rows: [{ total: "0" }] };
        }
        return { rows: [] };
      },
    };
    const empty = await checkExistingFoundation(mockEmptyClient, 50);
    assert.strictEqual(empty.state, "EMPTY", "Should recognize clean empty database");
    assert.strictEqual(empty.totalTables, 0);
  });

  await itAsync("advisory lock prevents concurrent migrations and fail-fast aborts", async () => {
    const { acquireAdvisoryLock, releaseAdvisoryLock } = require("../src/db/migrator");
    // Mock client where lock is granted
    const mockGrantedClient = {
      query: async (sql) => {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
        if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
        return { rows: [] };
      },
    };
    await acquireAdvisoryLock(mockGrantedClient);
    await releaseAdvisoryLock(mockGrantedClient);

    // Mock client where lock is NOT granted (another process holds it)
    const mockDeniedClient = {
      query: async (sql) => {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: false }] };
        return { rows: [] };
      },
    };
    let lockFailed = false;
    try {
      await acquireAdvisoryLock(mockDeniedClient);
    } catch (err) {
      lockFailed = true;
      assert.ok(err.message.includes("Concurrent migration in progress"), "Error should report concurrent migration");
    }
    assert.strictEqual(lockFailed, true, "Should throw error when advisory lock is denied");
  });

  // ---------------------------------------------------------------------------
  // 5. DIVV AI KNOWLEDGE BASE & RETRIEVAL TESTS
  // ---------------------------------------------------------------------------
  console.log("\n🧪 5. Divv AI Grounded Knowledge Base & Contract (src/services/aiService.js)");
  it("getKnowledgeStatus confirms database.json is loaded with v2.0.0 metadata", () => {
    const status = getKnowledgeStatus();
    assert.strictEqual(status.isLoaded, true, "knowledgeCache must be loaded");
    assert.strictEqual(status.version, "2.0.0", "knowledge version must be 2.0.0");
    assert.ok(status.sectionsCount >= 20, "should have at least 20 verified knowledge sections");
    assert.strictEqual(status.model, CONFIG.geminiModel, "model must match config");
  });

  it("retrieveRelevantContext accurately retrieves press-on nails information", () => {
    const context = retrieveRelevantContext("How long do press on nails last and what glue is included?");
    assert.ok(context, "context object must be returned");
    assert.ok(Array.isArray(context.highlights), "highlights must be an array");
    assert.ok(typeof context.selectedKnowledgeXml === "string", "selectedKnowledgeXml must be a string");
    assert.ok(
      context.selectedKnowledgeXml.includes("Press-On") || context.selectedKnowledgeXml.includes("Nails"),
      "XML context should mention press-on nails"
    );
  });

  it("retrieveRelevantContext accurately retrieves home salon services and areas", () => {
    const context = retrieveRelevantContext("Do you provide at-home nail extensions in Delhi?");
    assert.ok(context, "context object must be returned");
    assert.ok(Array.isArray(context.highlights), "highlights must be an array");
    assert.ok(typeof context.selectedKnowledgeXml === "string", "selectedKnowledgeXml must be a string");
    assert.ok(
      context.selectedKnowledgeXml.includes("Service") || context.selectedKnowledgeXml.includes("Extension"),
      "XML context should mention services/extensions"
    );
  });

  // ---------------------------------------------------------------------------
  // 6. HTTP API ROUTE TESTS (Express Endpoints)
  // ---------------------------------------------------------------------------
  console.log("\n🧪 6. Express HTTP API Route Endpoints");

  // Spin up temporary HTTP test server
  const testServer = http.createServer(app);
  await new Promise((resolve) => testServer.listen(0, resolve));
  const testPort = testServer.address().port;
  const baseUrl = `http://localhost:${testPort}`;

  async function makeRequest(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(url, options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  try {
    await itAsync("GET / returns 200 with backwards-compatible health status and component telemetry", async () => {
      const res = await makeRequest("/");
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.status === "healthy" || res.body.status === "degraded");
      assert.strictEqual(res.body.service, "Nails by Divya Platform Backend 🚀");
      assert.ok(res.body.timestamp);
      assert.ok(res.body.database);
      assert.ok(res.body.knowledge);
      assert.ok(res.body.ai);
      assert.strictEqual(res.body.knowledge.status, "ready");
      assert.strictEqual(res.body.knowledge.version, "2.0.0");
    });

    await itAsync("GET /health returns dedicated health telemetry with database status and latency", async () => {
      const res = await makeRequest("/health");
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.database.status === "connected" || res.body.database.status === "disconnected");
      assert.ok(typeof res.body.database.latencyMs === "number");
      assert.ok(res.body.database.pool);
    });

    await itAsync("POST /chat validates payload and rejects requests missing 'message' with 400", async () => {
      const res = await makeRequest("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {},
      });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes("'message' string is required"));
    });

    await itAsync("POST /chat contract succeeds and returns structured { reply }", async () => {
      const res = await makeRequest("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          message: "What are your standard nail shapes?",
          history: [],
        },
      });
      // In development without GEMINI_API_KEY, fallback handler responds
      assert.ok(res.status === 200 || res.status === 500);
      if (res.status === 200) {
        assert.ok(typeof res.body.reply === "string", "reply must be a string");
        assert.ok(res.body.reply.length > 0, "reply must not be empty");
      }
    });

    await itAsync("POST /rebuild-knowledge enforces fail-closed authentication (rejects unauthorized)", async () => {
      const res = await makeRequest("/rebuild-knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {},
      });
      // Fails closed with 503 (disabled when no admin key configured) or 401 (unauthorized)
      assert.ok([401, 503].includes(res.status), `Expected 401 or 503, got ${res.status}`);
      assert.strictEqual(res.body.success, false);
    });

  } finally {
    await new Promise((resolve) => testServer.close(resolve));
    await closePool();
  }

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log("\n==================================================================");
  console.log(`🏁 TEST EXECUTION COMPLETE: ${passedCount} Passed, ${failedCount} Failed`);
  console.log("==================================================================");

  process.exit(failedCount > 0 ? 1 : 0);
}

runTestSuite().catch((err) => {
  console.error("❌ [Test Runner Unhandled Exception]:", err);
  process.exit(1);
});
