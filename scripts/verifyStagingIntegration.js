/**
 * ==========================================================================
 * LIVE STAGING INTEGRATION VERIFICATION (`scripts/verifyStagingIntegration.js`)
 * Tests real PostgreSQL connectivity against nailsbydivya_staging,
 * verifies record counts across all domains, and validates API health probes.
 * ==========================================================================
 */

const assert = require("assert");
const http = require("http");
const { getPool, query, checkHealth, closePool } = require("../src/db/pool");
const { getMigrationStatus } = require("../src/db/migrator");
const app = require("../index");

async function verifyStaging() {
  console.log("==================================================================");
  console.log("   NAILS BY DIVYA — STAGING DATABASE INTEGRATION VERIFICATION");
  console.log("==================================================================\n");

  try {
    // 1. Live Connectivity Check
    console.log("🔌 1. Testing Live PostgreSQL Connectivity...");
    const health = await checkHealth();
    if (health.status !== "connected") {
      console.error(`❌ Connection to nailsbydivya_staging failed: ${health.error}`);
      console.error(`   Please check PGPASSWORD or DATABASE_URL in .env.\n`);
      process.exit(1);
    }
    console.log(`✅ Connected successfully! (Latency: ${health.latencyMs}ms)`);
    console.log(`   Pool stats: total=${health.pool.total}, idle=${health.pool.idle}, waiting=${health.pool.waiting}\n`);

    // 2. Foundation Recognition Check
    console.log("📋 2. Verifying Migration Foundation Recognition...");
    const migrationStatus = await getMigrationStatus();
    console.log(`   Manifest Version: ${migrationStatus.manifestVersion}`);
    const initialMigration = migrationStatus.migrations.find((m) => m.name === "001_initial_schema");
    assert.ok(initialMigration, "001_initial_schema migration must exist in status");
    console.log(`   Migration [001_initial_schema] Status: ${initialMigration.status}`);
    assert.strictEqual(initialMigration.status, "APPLIED", "001_initial_schema should be recognized as APPLIED");
    console.log(`✅ Foundation safely recognized without re-executing initial DDL.\n`);

    // 3. Staging Schema & Record Count Audit
    console.log("🔍 3. Auditing Staging Database Tables and Record Counts...");
    const tablesRes = await query(`
      SELECT COUNT(*) AS total
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name != 'schema_migrations';
    `);
    const tableCount = parseInt(tablesRes.rows[0].total, 10);
    console.log(`   Base tables in public schema: ${tableCount}`);
    assert.strictEqual(tableCount, 50, "Expected exactly 50 base tables in nailsbydivya_staging");

    const countsRes = await query(`
      SELECT 'roles' AS table_name, COUNT(*) AS count FROM roles
      UNION ALL SELECT 'permissions', COUNT(*) FROM permissions
      UNION ALL SELECT 'services', COUNT(*) FROM services
      UNION ALL SELECT 'service_addons', COUNT(*) FROM service_addons
      UNION ALL SELECT 'service_areas', COUNT(*) FROM service_areas
      UNION ALL SELECT 'products', COUNT(*) FROM products
      UNION ALL SELECT 'product_images', COUNT(*) FROM product_images
      UNION ALL SELECT 'portfolio_designs', COUNT(*) FROM portfolio_designs
      UNION ALL SELECT 'faqs', COUNT(*) FROM faqs
      UNION ALL SELECT 'business_settings', COUNT(*) FROM business_settings
      ORDER BY table_name;
    `);

    const expectedCounts = {
      roles: 4,
      permissions: 15,
      services: 5,
      service_addons: 3,
      service_areas: 1,
      products: 22,
      product_images: 22,
      portfolio_designs: 60,
      faqs: 31,
      business_settings: 9,
    };

    console.log("   ------------------------------------------------");
    console.log("   TABLE NAME".padEnd(25) + "EXPECTED".padEnd(12) + "ACTUAL");
    console.log("   ------------------------------------------------");

    for (const row of countsRes.rows) {
      const exp = expectedCounts[row.table_name];
      const actual = parseInt(row.count, 10);
      console.log(`   ${row.table_name.padEnd(22)} ${String(exp).padEnd(11)} ${actual}`);
      assert.strictEqual(actual, exp, `Record count mismatch for ${row.table_name}: expected ${exp}, got ${actual}`);
    }
    console.log("   ------------------------------------------------");
    console.log(`✅ All 10 key seed tables verified with 100% exact record counts intact.\n`);

    // 4. Live Server HTTP Telemetry Probe
    console.log("🌐 4. Probing Live Server HTTP Endpoints with Connected Database...");
    const testServer = http.createServer(app);
    await new Promise((resolve) => testServer.listen(0, resolve));
    const testPort = testServer.address().port;
    const baseUrl = `http://localhost:${testPort}`;

    const get = (p) =>
      new Promise((res, rej) => {
        http
          .get(`${baseUrl}${p}`, (r) => {
            let d = "";
            r.on("data", (c) => (d += c));
            r.on("end", () => res({ status: r.statusCode, body: JSON.parse(d) }));
          })
          .on("error", rej);
      });

    const rootRes = await get("/");
    assert.strictEqual(rootRes.status, 200);
    assert.strictEqual(rootRes.body.status, "healthy");
    assert.strictEqual(rootRes.body.database.status, "connected");
    console.log(`   GET /           -> Status: ${rootRes.body.status} (Database: ${rootRes.body.database.status}, Latency: ${rootRes.body.database.latencyMs}ms)`);

    const healthRes = await get("/health");
    assert.strictEqual(healthRes.status, 200);
    assert.strictEqual(healthRes.body.status, "healthy");
    assert.strictEqual(healthRes.body.database.status, "connected");
    console.log(`   GET /health     -> Status: ${healthRes.body.status} (Pool: total=${healthRes.body.database.pool.total}, idle=${healthRes.body.database.pool.idle})`);

    await new Promise((resolve) => testServer.close(resolve));
    console.log(`✅ Live HTTP server health probes verified healthy.\n`);

    console.log("==================================================================");
    console.log("🎉 ALL STAGING INTEGRATION & RECORD VERIFICATIONS PASSED CLEANLY!");
    console.log("==================================================================\n");

    await closePool();
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ [Verification Failed]:`, err.message);
    await closePool();
    process.exit(1);
  }
}

verifyStaging();
