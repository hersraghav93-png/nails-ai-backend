"use strict";

// node scripts/withDisposableCheckoutDb.js [PostgreSQL bin directory]
// Each suite gets its own database in a new loopback-only cluster.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const prefix = "nbd-checkout-test-";
const suites = [
  "testMigrationApproval", "testBackend", "testCatalogCheckoutPricing", "testCheckoutOwnership", "testCommerce", "testStorefrontCustomerJourneys",
  "testCustomerEmailAuth", "testEmailLinkDelivery", "testPaymentVerification", "testBookings", "testCommunications",
  "testAccountSwitchingAndSessionIsolation",
];

function verifyFixture() {
  const env = process.env;
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.PGHOST, "127.0.0.1");
  assert.ok(!env.DATABASE_URL && /^checkout_\d+$/.test(env.PGDATABASE));
  const data = fs.realpathSync(env.NBD_CHECKOUT_TEST_DATA);
  assert.equal(path.dirname(path.dirname(data)), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(path.dirname(data)).startsWith(prefix));
  const pid = fs.readFileSync(path.join(data, "postmaster.pid"), "utf8").split(/\r?\n/);
  assert.equal(fs.realpathSync(pid[1]), data);
  assert.equal(pid[3], env.PGPORT);
}

function isolateProviders() {
  verifyFixture();
  require("dotenv").config = () => ({ parsed: {} });
  const realFetch = global.fetch;
  global.fetch = (input, options) => {
    const url = new URL(input.url || input);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "External fetch blocked in checkout test");
    return realFetch(input, options);
  };
  const adapter = require("../src/services/notifications/whatsappAdapter");
  adapter.sendWhatsAppNotification = async () => ({
    success: true, deliveryStatus: "SENT", providerMessageId: "sim_wa_" + crypto.randomUUID(), isSimulated: true,
  });
}

async function bootstrap(suite) {
  isolateProviders();
  const { query, closePool } = require("../src/db/pool");
  const sql = name => fs.readFileSync(path.join(root, "database", name), "utf8");
  try {
    if (suite === "testMigrationApproval") return;
    const files = [
      "migrations/001_initial_schema.sql", "seeds/001_roles_and_categories.sql",
      "seeds/002_catalog_products.sql", "migrations/002_add_firebase_uid.sql",
      "migrations/003_reconcile_service_catalog_pricing.sql", "migrations/004_add_payment_status_type_to_history.sql",
      "migrations/005_add_customer_reviews.sql", "migrations/008_customer_email_auth_tokens.sql",
    ];
    // Historical migration 003 predates the current service catalogue.
    files.push("seeds/001_roles_and_categories.sql");
    if (suite !== "testCheckoutOwnership") files.push("migrations/009_checkout_attempts.sql");
    for (const file of files) await query(sql(file));
    if (suite === "testStorefrontCustomerJourneys") {
      await query("INSERT INTO users(email, email_verified_at) VALUES ('journey@example.invalid', now())");
    }
    if (suite === "testCommunications") {
      await query(`WITH buyer AS (INSERT INTO users(email) VALUES ('fulfilment@example.invalid') RETURNING id)
        INSERT INTO orders(order_number,user_id,customer_name,customer_phone,shipping_address,subtotal,total_amount)
        SELECT 'FIXTURE-FULFILMENT', id, 'Fixture', '+919000000001', '{}', 599, 599 FROM buyer`);
    }
  } finally {
    await closePool();
  }
}

async function run() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = String(server.address().port);
  await new Promise(resolve => server.close(resolve));
  const tmp = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tmp, prefix));
  const data = path.join(dir, "data");
  const pw = path.join(dir, "init-password");
  const bin = process.argv[2] || "";
  const requested = process.argv.slice(3);
  if (requested.some(suite => !suites.includes(suite))) throw new Error("Unknown test suite");
  const selected = requested.length ? requested : suites;
  const env = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, {
    NODE_ENV: "test", PGHOST: "127.0.0.1", PGPORT: port,
    PGUSER: "checkout_fixture", PGPASSWORD: crypto.randomBytes(24).toString("hex"),
    NBD_CHECKOUT_TEST_DATA: data, FRONTEND_BASE_URL: "http://localhost:8080",
  });
  const command = (exe, args) => {
    const result = spawnSync(exe, args, { cwd: root, env, stdio: "inherit", windowsHide: true, timeout: 120000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(path.basename(exe) + " failed with status " + result.status);
  };
  const pg = (name, args) => command(bin ? path.join(bin, name) : name, args);
  try {
    fs.writeFileSync(pw, env.PGPASSWORD, { mode: 0o600 });
    pg("initdb", ["-D", data, "-U", env.PGUSER, "--pwfile", pw, "-A", "scram-sha-256", "--encoding=UTF8", "--no-locale"]);
    fs.unlinkSync(pw);
    pg("pg_ctl", ["-D", data, "-l", path.join(dir, "postgres.log"), "-o", "-h 127.0.0.1 -p " + port, "-w", "start"]);
    for (const [i, suite] of selected.entries()) {
      env.PGDATABASE = "checkout_" + i;
      pg("createdb", ["--maintenance-db=postgres", env.PGDATABASE]);
      command(process.execPath, [__filename, "--schema", suite]);
      command(process.execPath, ["-r", __filename, path.join(__dirname, suite + ".js")]);
    }
  } finally {
    if (fs.existsSync(path.join(data, "postmaster.pid"))) pg("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
    const target = fs.realpathSync(dir);
    assert.equal(path.dirname(target), tmp);
    assert.ok(path.basename(target).startsWith(prefix));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 });
  }
}

module.exports = { verifyFixture };
if (require.main !== module) {
  isolateProviders();
} else {
  const task = process.argv[2] === "--schema" ? bootstrap(process.argv[3]) : run();
  task.catch(err => { console.error(err.message); process.exitCode = 1; });
}
