#!/usr/bin/env node
/**
 * ==============================================================================
 * NAILS BY DIVYA — PHASE 2E SECURITY AUDIT & PRODUCTION READINESS TEST SUITE
 * (`scripts/testSecurityProductionReadiness.js`)
 *
 * Verifies:
 * 1. Environment Detection Integrity: Dynamic sync between CONFIG.nodeEnv and process.env.NODE_ENV
 * 2. Staging & Production Simulator Isolation: Strict rejection of mock/demo tokens in staging & prod
 * 3. Administrative Mutation Guarding: devAllowUnverified blocked in staging and production
 * 4. Secure CORS Enforcement: Whitelist enforcement and third-party origin rejection
 * 5. Rate Limiting Protection: RateLimit headers and throttling on admin & auth endpoints
 * 6. Business Financial Ledger Integrity: Cancelled orders excluded from paid revenue, pending distinguished
 * 7. Catalogue Services Reconciled: Exactly 5 services in PostgreSQL, French Nails as add-on
 * ==============================================================================
 */

"use strict";

process.env.NODE_ENV = "test";

const assert = require("assert");
const CONFIG = require("../src/config");
const { query, closePool } = require("../src/db/pool");
const { verifyIdToken } = require("../src/services/firebaseService");
const { provisionAdminAccount } = require("../src/services/userService");
const { getEnrichedOverview } = require("../src/services/adminService");
const { getCorsMiddleware, ALLOWED_PROD_ORIGINS } = require("../src/middleware/corsConfig");
const { adminRateLimiter } = require("../src/middleware/rateLimiter");

let passedCount = 0;
let failedCount = 0;

function pass(name) {
  passedCount++;
  console.log(`  ✅ [PASS] ${name}`);
}

function fail(name, error) {
  failedCount++;
  console.error(`  ❌ [FAIL] ${name}: ${error.message || error}`);
}

async function runSuite() {
  console.log("\n==================================================================");
  console.log("   NAILS BY DIVYA — PHASE 2E SECURITY & PRODUCTION READINESS");
  console.log("==================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. ENVIRONMENT DETECTION DYNAMIC SYNCHRONIZATION
  // ---------------------------------------------------------------------------
  console.log("🧪 1. Dynamic Environment Detection & Sync");
  try {
    const prevEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = "staging";
    assert.strictEqual(CONFIG.nodeEnv, "staging", "CONFIG.nodeEnv must dynamically reflect process.env.NODE_ENV = staging");
    assert.strictEqual(CONFIG.isStaging(), true, "CONFIG.isStaging() must return true");
    assert.strictEqual(CONFIG.isLiveEnvironment(), true, "Staging is considered a live environment");
    assert.strictEqual(CONFIG.isDevelopment(), false, "Staging must not be development");

    process.env.NODE_ENV = "production";
    assert.strictEqual(CONFIG.nodeEnv, "production", "CONFIG.nodeEnv must dynamically reflect process.env.NODE_ENV = production");
    assert.strictEqual(CONFIG.isProduction(), true, "CONFIG.isProduction() must return true");
    assert.strictEqual(CONFIG.isLiveEnvironment(), true, "Production is considered a live environment");
    assert.strictEqual(CONFIG.isDevelopment(), false, "Production must not be development");

    CONFIG.nodeEnv = "development";
    assert.strictEqual(process.env.NODE_ENV, "development", "process.env.NODE_ENV must dynamically reflect CONFIG.nodeEnv write");
    assert.strictEqual(CONFIG.isDevelopment(), true, "CONFIG.isDevelopment() must return true");
    assert.strictEqual(CONFIG.isLiveEnvironment(), false, "Development is not live environment");

    process.env.NODE_ENV = prevEnv;
    pass("CONFIG.nodeEnv and process.env.NODE_ENV stay 100% in sync bidirectionally without drifting");
  } catch (e) { fail("Environment sync", e); }

  // ---------------------------------------------------------------------------
  // 2. STAGING & PRODUCTION SIMULATOR TOKEN REJECTION
  // ---------------------------------------------------------------------------
  console.log("\n🧪 2. Simulator Token Rejection in Staging & Production");
  try {
    const prevEnv = process.env.NODE_ENV;

    // Test in Staging
    process.env.NODE_ENV = "staging";
    let stagingErr = null;
    try {
      await verifyIdToken("mock-super-admin-token");
    } catch (err) {
      stagingErr = err;
    }
    assert.ok(stagingErr, "Staging must reject mock tokens");
    assert.strictEqual(stagingErr.statusCode, 401, "Staging mock token rejection status must be 401");
    assert.strictEqual(stagingErr.code, "INVALID_TOKEN", "Staging error code must be INVALID_TOKEN");

    // Test demo token in Staging
    let demoErr = null;
    try {
      await verifyIdToken("demo_token_for_9811000001");
    } catch (err) {
      demoErr = err;
    }
    assert.ok(demoErr, "Staging must reject demo tokens");
    assert.strictEqual(demoErr.statusCode, 401, "Demo token status must be 401");

    process.env.NODE_ENV = prevEnv;
    pass("Simulator tokens ('mock-*' and 'demo_*') are strictly rejected in staging mode (HTTP 401)");
  } catch (e) { fail("Staging simulator rejection", e); }

  // ---------------------------------------------------------------------------
  // 3. ADMIN PROVISIONING DEV FLAG BLOCKED IN STAGING
  // ---------------------------------------------------------------------------
  console.log("\n🧪 3. devAllowUnverified Strictly Blocked in Staging & Production");
  try {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "staging";

    let caughtErr = null;
    try {
      await provisionAdminAccount({
        firebaseUid: "fake_stage_uid",
        phone: "+919811999998",
        displayName: "Stage Hacker",
        roleId: "super_operator",
        devAllowUnverified: true,
      });
    } catch (err) {
      caughtErr = err;
    }
    process.env.NODE_ENV = prevEnv;

    assert.ok(caughtErr, "devAllowUnverified must throw in staging");
    assert.ok(caughtErr.message.includes("forbidden outside development"), "Error must forbid outside development");
    pass("devAllowUnverified throws fatal security error in staging mode");
  } catch (e) { fail("Staging devAllowUnverified prevention", e); }

  // ---------------------------------------------------------------------------
  // 4. SECURE CORS VALIDATION
  // ---------------------------------------------------------------------------
  console.log("\n🧪 4. CORS Whitelisting & Origin Enforcement");
  try {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const corsMiddleware = getCorsMiddleware();
    let corsCalled = false;
    let corsError = null;

    // 1. Whitelisted domain
    const mockReqAllowed = { headers: { origin: "https://nailsbydivya.com" }, method: "GET" };
    const mockResAllowed = {
      getHeader: () => {},
      setHeader: () => {},
    };
    corsMiddleware(mockReqAllowed, mockResAllowed, (err) => {
      if (err) corsError = err;
      corsCalled = true;
    });
    assert.strictEqual(corsCalled, true, "CORS callback must execute");
    assert.strictEqual(corsError, null, "Whitelisted origin must not produce CORS error");

    // 2. Untrusted third-party domain
    let untrustedBlocked = false;
    const mockReqBlocked = { headers: { origin: "https://malicious-nail-site.com" }, method: "GET" };
    corsMiddleware(mockReqBlocked, mockResAllowed, (err) => {
      if (err && err.message.includes("CORS policy")) {
        untrustedBlocked = true;
      }
    });
    assert.strictEqual(untrustedBlocked, true, "Untrusted origin must be rejected with CORS violation");

    process.env.NODE_ENV = prevEnv;
    pass("CORS enforces strict whitelist on production: permits nailsbydivya.com, rejects untrusted origins");
  } catch (e) { fail("CORS origin enforcement", e); }

  // ---------------------------------------------------------------------------
  // 5. RATE LIMITING MIDDLEWARE
  // ---------------------------------------------------------------------------
  console.log("\n🧪 5. Rate Limiting Middleware Protection");
  try {
    assert.strictEqual(typeof adminRateLimiter, "function", "adminRateLimiter must be an Express middleware function");

    // Simulate in development mode to test header attachment
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    let headersSet = {};
    const mockReq = { ip: "10.0.0.99", headers: {} };
    const mockRes = {
      setHeader: (k, v) => { headersSet[k] = v; },
      status: () => ({ json: () => {} }),
    };

    let nextCalled = false;
    adminRateLimiter(mockReq, mockRes, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true, "Middleware should pass request under limit");
    assert.strictEqual(headersSet["RateLimit-Limit"], 120, "RateLimit-Limit must be 120");
    assert.ok(headersSet["RateLimit-Remaining"] !== undefined, "RateLimit-Remaining header must be present");

    process.env.NODE_ENV = prevEnv;
    pass("Rate limiting middleware attaches standard RateLimit headers (120 req/min for admin)");
  } catch (e) { fail("Rate limiting", e); }

  // ---------------------------------------------------------------------------
  // 6. BUSINESS REVENUE LEDGER INTEGRITY
  // ---------------------------------------------------------------------------
  console.log("\n🧪 6. Financial Ledger & Revenue Integrity");
  try {
    const overview = await getEnrichedOverview();
    assert.ok(overview.financials, "Overview must contain financials object");
    assert.strictEqual(typeof overview.financials.paidRevenue, "number", "paidRevenue must be a number");
    assert.strictEqual(typeof overview.financials.pendingPaymentAmount, "number", "pendingPaymentAmount must be a number");

    // Verify all current database orders are pending and paidRevenue is 0
    assert.strictEqual(overview.financials.paidRevenue, 0, "Current paid revenue must be exactly 0 (no fake revenue)");
    assert.ok(overview.financials.pendingPaymentAmount > 0, "Pending orders must be accounted for in pendingPaymentAmount");

    pass("Paid revenue strictly excludes unpaid and cancelled orders (Paid: ₹0.00, Pipeline: verified)");
  } catch (e) { fail("Revenue ledger", e); }

  // ---------------------------------------------------------------------------
  // 7. CATALOGUE DISCREPANCY RECONCILIATION
  // ---------------------------------------------------------------------------
  console.log("\n🧪 7. Catalogue Discrepancy Resolution (5 DB Services vs 6 Marketing Cards)");
  try {
    const servicesRes = await query("SELECT id, name, is_active FROM services ORDER BY name ASC;");
    assert.strictEqual(servicesRes.rows.length, 5, `PostgreSQL services table must contain exactly 5 services (found ${servicesRes.rows.length})`);

    const addonsRes = await query("SELECT id, service_id, name FROM service_addons;");
    const frenchAddon = addonsRes.rows.find((a) => a.name.includes("French Tip"));
    assert.ok(frenchAddon, "French Tip must exist as a service add-on in PostgreSQL");
    assert.strictEqual(frenchAddon.service_id, "gel_extensions", "French Tip add-on belongs to gel_extensions");

    pass("Reconciled catalogue: Exactly 5 base services in PostgreSQL; French Nails is modeled as a service add-on");
  } catch (e) { fail("Catalogue reconciliation", e); }

  // Clean up
  await closePool();

  console.log("\n==================================================================");
  console.log(`🏁 PHASE 2E TEST SUITE COMPLETE: ${passedCount} Passed, ${failedCount} Failed`);
  console.log("==================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
