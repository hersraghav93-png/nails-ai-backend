const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");

require("./withDisposableCheckoutDb").verifyFixture();
const { query, closePool } = require("../src/db/pool");
const { getMigrationStatus, runMigrations } = require("../src/db/migrator");

const preload = ["-r", "./scripts/withDisposableCheckoutDb.js"];
const cli = (...args) => spawnSync(process.execPath, [...preload, "scripts/migrate.js", ...args], {
  encoding: "utf8", timeout: 15000,
});
const table = async (name) => (await query("SELECT to_regclass($1)::text AS name", [name])).rows[0].name;
const status = async (id) => (await getMigrationStatus()).migrations.find(m => m.id === id).status;
const ledger = async () => (await query("SELECT id FROM schema_migrations ORDER BY id")).rows.map(row => row.id);

async function startup() {
  for (const file of ["render.yaml", "render.staging.yaml"]) {
    assert.match(fs.readFileSync(file, "utf8"), /^ +startCommand: npm start\s*$/m);
  }
  const start = require("../package.json").scripts.start;
  assert.equal(start, "node index.js");
  const server = spawn(process.execPath, [...preload, "index.js"], {
    env: { ...process.env, PORT: "0" },
  });
  const exited = once(server, "exit");
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server did not start")), 15000);
      server.once("error", (err) => { clearTimeout(timer); reject(err); });
      server.once("exit", () => { clearTimeout(timer); reject(new Error("Server exited early")); });
      server.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("[Nails by Divya Server] Running")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } finally {
    server.kill();
    await exited;
  }
}

async function main() {
  assert.equal(cli("--status").status, 0);
  assert.equal(await table("public.schema_migrations"), null);
  assert.equal(await status("001"), "PENDING");
  assert.equal(await status("009"), "APPROVAL_REQUIRED");
  assert.equal(cli("--status", "--up").status, 1);
  assert.equal(cli("--up", "--approve", "006").status, 1);
  assert.equal(cli("--up", "--approve", "009_checkout_attempts").status, 1);
  assert.equal(await table("public.schema_migrations"), null);
  await startup();
  assert.equal(await table("public.users"), null);
  console.log("PASS status and application startup leave an empty database untouched");

  // Initialize the foundation and prerequisite role/catalog seed as on a provisioned target.
  for (const file of ["migrations/001_initial_schema.sql", "seeds/001_roles_and_categories.sql"]) {
    await query(fs.readFileSync("database/" + file, "utf8"));
  }
  assert.equal(await status("001"), "PRESENT_UNRECORDED");
  assert.equal(await table("schema_migrations"), null);

  // Exercise the legacy startup migration command against the baseline.
  const baseline = cli("--up");
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.deepEqual(await ledger(), ["001", "002", "003", "004", "005"]);
  for (const name of ["analytics_daily_events", "email_login_tokens", "checkout_attempts"]) {
    assert.equal(await table(name), null);
  }
  assert.equal((await query("SELECT count(*)::int AS n FROM users")).rows[0].n, 0);
  console.log("PASS baseline-only runner leaves 006–009 pending");

  await query(fs.readFileSync("database/migrations/008_customer_email_auth_tokens.sql", "utf8"));
  assert.equal(await status("008"), "PRESENT_UNRECORDED");
  assert.equal(cli("--up", "--approve", "008_customer_email_auth_tokens").status, 1);
  assert.deepEqual(await ledger(), ["001", "002", "003", "004", "005"]);
  await startup();
  assert.equal(await status("007"), "APPROVAL_REQUIRED");
  assert.equal(await table("checkout_attempts"), null);
  console.log("PASS an existing 008 is neither replayed nor recorded by status or startup");

  // Force the ledger write to fail and prove the migration DDL rolls back with it.
  await query("ALTER TABLE schema_migrations ADD CONSTRAINT fixture_block_009 CHECK (id <> '009')");
  await assert.rejects(runMigrations({ approve: "009_checkout_attempts" }), /failed/);
  assert.equal(await table("checkout_attempts"), null);
  await query("ALTER TABLE schema_migrations DROP CONSTRAINT fixture_block_009");
  const approved = cli("--up", "--approve", "009_checkout_attempts");
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(cli("--up", "--approve", "009_checkout_attempts").status, 0);
  assert.deepEqual(await ledger(), ["001", "002", "003", "004", "005", "009"]);
  assert.equal(await status("009"), "APPLIED");
  assert.equal(await table("analytics_daily_events"), null);
  assert.equal(await status("007"), "APPROVAL_REQUIRED");
  assert.equal(await status("008"), "PRESENT_UNRECORDED");
  console.log("PASS exact approval applies only one migration and commits with its ledger record");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(closePool);
