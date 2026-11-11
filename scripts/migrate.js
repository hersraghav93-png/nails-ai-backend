/**
 * ==========================================================================
 * CLI MIGRATION RUNNER (`scripts/migrate.js`)
 * Usage:
 *   node scripts/migrate.js --status
 *   node scripts/migrate.js --up
 * ==========================================================================
 */

const { runMigrations, getMigrationStatus } = require("../src/db/migrator");
const { checkHealth, closePool } = require("../src/db/pool");

async function main() {
  const args = process.argv.slice(2);
  const isStatus = args.includes("--status");
  const isUp = args.includes("--up") || args.length === 0;

  console.log("==================================================================");
  console.log("   NAILS BY DIVYA — DATABASE MIGRATION RUNNER");
  console.log("==================================================================\n");

  try {
    // 1. Check DB health first
    const health = await checkHealth();
    if (health.status !== "connected") {
      console.error(`❌ [Connection Error] Unable to connect to PostgreSQL.`);
      console.error(`   Details: ${health.error || "Connection timed out"}`);
      console.error(`   Please check your .env database configuration.\n`);
      process.exit(1);
    }
    console.log(`🔌 [Connected] PostgreSQL latency: ${health.latencyMs}ms\n`);

    // 2. Report Status
    const status = await getMigrationStatus();
    console.log(`📋 Manifest Version: ${status.manifestVersion}`);
    console.log("------------------------------------------------------------------");
    console.log(
      "ID".padEnd(6) +
      "NAME".padEnd(28) +
      "STATUS".padEnd(12) +
      "TIME (ms)".padEnd(12) +
      "APPLIED AT"
    );
    console.log("------------------------------------------------------------------");

    for (const m of status.migrations) {
      const timeStr = m.executionTimeMs !== null ? `${m.executionTimeMs}` : "-";
      const appliedStr = m.appliedAt ? new Date(m.appliedAt).toISOString() : "-";
      console.log(
        m.id.padEnd(6) +
        m.name.padEnd(28) +
        m.status.padEnd(12) +
        timeStr.padEnd(12) +
        appliedStr
      );
    }
    console.log("------------------------------------------------------------------\n");

    if (isStatus && !args.includes("--up")) {
      await closePool();
      process.exit(0);
    }

    // 3. Apply Migrations if --up
    if (isUp) {
      const result = await runMigrations();
      console.log(`\n🎉 [Migration Summary]`);
      console.log(`   • Applied: ${result.applied.length > 0 ? result.applied.join(", ") : "None (up to date)"}`);
      console.log(`   • Skipped: ${result.skipped.length > 0 ? result.skipped.join(", ") : "None"}`);
      console.log(`   • Total Manifest Migrations: ${result.total}\n`);
    }

    await closePool();
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ [Fatal Migration Error]:`, err.message);
    await closePool();
    process.exit(1);
  }
}

main();
