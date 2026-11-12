#!/usr/bin/env node
/**
 * ==============================================================================
 * NAILS BY DIVYA — PHASE 2D REAL AUTH & END-TO-END INTEGRATION TEST SUITE
 * (`scripts/testAuthIntegration.js`)
 *
 * Rigorously verifies:
 * 1. Health check endpoints (/health, /api/health, /)
 * 2. Production safety: Simulator token rejection in production mode
 * 3. Fail-closed security when Firebase Admin credentials are unconfigured
 * 4. Server-side identity & permission derivation from PostgreSQL
 * 5. Role-based access control (RBAC) across Super Operator, Divya, Priya, and Customer
 * 6. Administrative provisioning security and audit logging
 * ==============================================================================
 */

"use strict";

process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const express = require("express");
const CONFIG = require("../src/config");
const { getPool, query, withTransaction, closePool } = require("../src/db/pool");
const { initAiService } = require("../src/services/aiService");
const {
  verifyIdToken,
  setTestTokenVerifier,
  clearTestTokenVerifier,
  verifyFirebaseAdminUser,
} = require("../src/services/firebaseService");
const {
  findOrCreateUserByFirebaseToken,
  provisionAdminAccount,
} = require("../src/services/userService");

const chatRouter = require("../src/routes/chatRoute");
const authRouter = require("../src/routes/authRoute");
const customerRouter = require("../src/routes/customerRoute");
const adminRouter = require("../src/routes/adminRoute");

let server = null;
let baseUrl = "";
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

function makeRequest(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, data: parsed, raw: data });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data: null, raw: data });
        }
      });
    });

    req.on("error", reject);
    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function setupTestApp() {
  initAiService();
  const app = express();
  app.use(express.json());
  app.use("/", chatRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/customer", customerRouter);
  app.use("/api/admin", adminRouter);

  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function runTests() {
  console.log("\n==================================================================");
  console.log("   NAILS BY DIVYA — PHASE 2D REAL AUTH & SECURITY INTEGRATION");
  console.log("==================================================================\n");

  await setupTestApp();

  const timestamp = Date.now();
  const superUid = `super_op_${timestamp}`;
  const divyaUid = `divya_artist_${timestamp}`;
  const priyaUid = `priya_staff_${timestamp}`;
  const customerUid = `regular_cust_${timestamp}`;

  const superPhone = `+919811${String(timestamp).slice(-6)}`;
  const divyaPhone = `+919812${String(timestamp).slice(-6)}`;
  const priyaPhone = `+919813${String(timestamp).slice(-6)}`;
  const custPhone = `+919814${String(timestamp).slice(-6)}`;

  // Provision accounts in database using test mock verifier
  setTestTokenVerifier(async (token) => {
    if (token === "token-super") return { uid: superUid, phone_number: superPhone };
    if (token === "token-divya") return { uid: divyaUid, phone_number: divyaPhone };
    if (token === "token-priya") return { uid: priyaUid, phone_number: priyaPhone };
    if (token === "token-customer") return { uid: customerUid, phone_number: custPhone };
    return null;
  });

  // Provision operators in PostgreSQL
  let superAdminUser, divyaUser, priyaUser;
  try {
    superAdminUser = await provisionAdminAccount({
      firebaseUid: superUid,
      phone: superPhone,
      displayName: "Super Raghav",
      roleId: "super_operator",
      devAllowUnverified: true,
    });

    divyaUser = await provisionAdminAccount({
      firebaseUid: divyaUid,
      phone: divyaPhone,
      displayName: "Artist Divya",
      roleId: "artist_divya",
      devAllowUnverified: true,
    });

    priyaUser = await provisionAdminAccount({
      firebaseUid: priyaUid,
      phone: priyaPhone,
      displayName: "Staff Priya",
      roleId: "staff_artist",
      devAllowUnverified: true,
    });

    // Create regular customer (no admin role)
    await findOrCreateUserByFirebaseToken({ uid: customerUid, phone_number: custPhone });
  } catch (err) {
    console.error("Setup error:", err);
  }

  // ---------------------------------------------------------------------------
  // 1. HEALTH CHECK ALIASES
  // ---------------------------------------------------------------------------
  console.log("🧪 1. Backend Health Check Endpoints (/health, /api/health, /)");
  try {
    const resRoot = await makeRequest("GET", "/");
    assert.strictEqual(resRoot.status, 200, "GET / must return 200");
    assert.strictEqual(resRoot.data.status, "healthy", "GET / status must be healthy");
    pass("GET / returns 200 with operational telemetry");
  } catch (e) { fail("GET /", e); }

  try {
    const resHealth = await makeRequest("GET", "/health");
    assert.strictEqual(resHealth.status, 200, "GET /health must return 200");
    assert.strictEqual(resHealth.data.database.status, "connected", "Database must be connected");
    pass("GET /health returns 200 with database connection telemetry");
  } catch (e) { fail("GET /health", e); }

  try {
    const resApiHealth = await makeRequest("GET", "/api/health");
    assert.strictEqual(resApiHealth.status, 200, "GET /api/health must return 200");
    assert.strictEqual(resApiHealth.data.status, "healthy", "GET /api/health status must be healthy");
    pass("GET /api/health returns 200 (alias endpoint functional)");
  } catch (e) { fail("GET /api/health", e); }

  // ---------------------------------------------------------------------------
  // 2. PRODUCTION SAFETY: SIMULATOR TOKENS STRICTLY REJECTED IN PRODUCTION
  // ---------------------------------------------------------------------------
  console.log("\n🧪 2. Production Safety & Simulator Token Rejection");
  try {
    // Temporarily simulate production environment
    const prevNodeEnv = CONFIG.nodeEnv;
    const prevEnvVar = process.env.NODE_ENV;
    CONFIG.nodeEnv = "production";
    process.env.NODE_ENV = "production";

    let caughtErr = null;
    try {
      await verifyIdToken("mock-super-admin-token");
    } catch (err) {
      caughtErr = err;
    }

    CONFIG.nodeEnv = prevNodeEnv;
    process.env.NODE_ENV = prevEnvVar;

    assert.ok(caughtErr, "Should throw error in production");
    assert.strictEqual(caughtErr.statusCode, 401, "Status code must be 401");
    assert.strictEqual(caughtErr.code, "INVALID_TOKEN", "Error code must be INVALID_TOKEN");
    assert.ok(caughtErr.message.includes("strictly forbidden in production"), "Message must mention forbidden in production");
    pass("Simulator tokens ('mock-*') are rejected with 401 in production mode");
  } catch (e) { fail("Simulator token rejection in production", e); }

  try {
    // Missing / Empty token
    const resNoToken = await makeRequest("GET", "/api/admin/me");
    assert.strictEqual(resNoToken.status, 401, "No token must return 401");
    assert.strictEqual(resNoToken.data.code, "AUTH_REQUIRED", "Error code must be AUTH_REQUIRED");
    pass("Unauthenticated request to /api/admin/* is rejected with 401 AUTH_REQUIRED");
  } catch (e) { fail("Missing token rejection", e); }

  // ---------------------------------------------------------------------------
  // 3. FAIL-CLOSED BEHAVIOR WHEN FIREBASE CREDENTIALS UNCONFIGURED
  // ---------------------------------------------------------------------------
  console.log("\n🧪 3. Fail-Closed Behavior for Unconfigured Firebase Admin");
  try {
    clearTestTokenVerifier(); // Remove test verifier hook
    const prevNodeEnv = CONFIG.nodeEnv;
    CONFIG.nodeEnv = "production";

    let caughtErr = null;
    try {
      await verifyIdToken("genuine-looking-jwt-token-12345");
    } catch (err) {
      caughtErr = err;
    }
    CONFIG.nodeEnv = prevNodeEnv;

    assert.ok(caughtErr, "Should throw when Firebase Admin is not configured");
    assert.strictEqual(caughtErr.statusCode, 503, "Status code must be 503");
    assert.strictEqual(caughtErr.code, "AUTH_SERVICE_UNCONFIGURED", "Code must be AUTH_SERVICE_UNCONFIGURED");
    pass("Live token verification fails closed with 503 AUTH_SERVICE_UNCONFIGURED when .env lacks credentials");
  } catch (e) { fail("Fail-closed unconfigured Firebase", e); }

  // Restore test verifier for remaining RBAC and flow tests
  setTestTokenVerifier(async (token) => {
    if (token === "token-super") return { uid: superUid, phone_number: superPhone };
    if (token === "token-divya") return { uid: divyaUid, phone_number: divyaPhone };
    if (token === "token-priya") return { uid: priyaUid, phone_number: priyaPhone };
    if (token === "token-customer") return { uid: customerUid, phone_number: custPhone };
    return null;
  });

  // ---------------------------------------------------------------------------
  // 4. SERVER-SIDE IDENTITY & PERMISSIONS DERIVATION
  // ---------------------------------------------------------------------------
  console.log("\n🧪 4. Server-Side Identity & Permissions Derivation");
  try {
    const resMe = await makeRequest("GET", "/api/admin/me", {
      Authorization: "Bearer token-super",
    });
    assert.strictEqual(resMe.status, 200, "Super Operator me must return 200");
    assert.strictEqual(resMe.data.admin.phone, superPhone, "Phone must match database record");
    assert.deepStrictEqual(resMe.data.admin.roles, ["super_operator"], "Role must be super_operator");
    assert.strictEqual(resMe.data.admin.permissions.length, 16, "Super Operator must have 16 permissions (including orders:verify_payment)");
    pass("GET /api/admin/me derives verified operator identity & exact 16 permissions from PostgreSQL");
  } catch (e) { fail("Server-side identity derivation", e); }

  try {
    // Attempt client role spoofing via header / body
    const resSpoof = await makeRequest(
      "GET",
      "/api/admin/me",
      {
        Authorization: "Bearer token-priya",
        "X-Admin-Role": "super_operator",
        "X-User-Permissions": "orders:refund,staff:manage",
      }
    );
    assert.strictEqual(resSpoof.status, 200);
    assert.deepStrictEqual(resSpoof.data.admin.roles, ["staff_artist"], "Role must remain staff_artist despite spoofed headers");
    assert.ok(!resSpoof.data.admin.permissions.includes("staff:manage"), "Priya must not receive staff:manage");
    pass("Client-supplied headers or claims cannot alter backend role or permissions");
  } catch (e) { fail("Client role spoofing prevention", e); }

  // ---------------------------------------------------------------------------
  // 5. ROLE-BASED ACCESS CONTROL (RBAC) BOUNDARIES
  // ---------------------------------------------------------------------------
  console.log("\n🧪 5. Role-Based Access Control (RBAC) Boundaries");
  try {
    // Customer rejection
    const resCust = await makeRequest("GET", "/api/admin/overview", {
      Authorization: "Bearer token-customer",
    });
    assert.strictEqual(resCust.status, 403, "Customer must be rejected with 403");
    assert.strictEqual(resCust.data.code, "FORBIDDEN_ROLE", "Code must be FORBIDDEN_ROLE");
    pass("Regular customer account is rejected from all admin endpoints with 403 FORBIDDEN_ROLE");
  } catch (e) { fail("Customer rejection from admin", e); }

  try {
    // Divya allowed to catalog & bookings, but forbidden from staff management
    const resDivyaOverview = await makeRequest("GET", "/api/admin/overview", {
      Authorization: "Bearer token-divya",
    });
    assert.strictEqual(resDivyaOverview.status, 200, "Divya has catalog:view permission for overview");

    const resDivyaStaff = await makeRequest("GET", "/api/admin/staff", {
      Authorization: "Bearer token-divya",
    });
    assert.strictEqual(resDivyaStaff.status, 403, "Divya lacks staff:manage and must be rejected with 403");
    pass("Lead Artist Divya can access overview & catalog, but is rejected with 403 from staff management");
  } catch (e) { fail("Divya permissions check", e); }

  try {
    // Priya can view orders & bookings, but forbidden from toggling product availability
    const resPriyaOrders = await makeRequest("GET", "/api/admin/orders", {
      Authorization: "Bearer token-priya",
    });
    assert.strictEqual(resPriyaOrders.status, 200, "Priya can read orders");

    // Get a valid product ID
    const prodRes = await query("SELECT id FROM products WHERE is_archived = FALSE LIMIT 1;");
    const productId = prodRes.rows[0].id;

    const resPriyaToggle = await makeRequest(
      "PATCH",
      `/api/admin/products/${productId}/availability`,
      { Authorization: "Bearer token-priya" },
      { is_active: false }
    );
    assert.strictEqual(resPriyaToggle.status, 403, "Priya lacks catalog:toggle_availability and must receive 403");
    pass("Staff Artist Priya can read orders & bookings, but cannot toggle catalog availability (403)");
  } catch (e) { fail("Priya permissions check", e); }

  // ---------------------------------------------------------------------------
  // 6. ADMINISTRATIVE PROVISIONING & AUDIT TRAIL
  // ---------------------------------------------------------------------------
  console.log("\n🧪 6. Administrative Provisioning & Audit Trail Verification");
  try {
    // Check audit logs table for the provisioning entries
    const auditRes = await query(
      `SELECT action, target_entity, target_id, diff FROM audit_logs WHERE action = 'ADMIN_ACCOUNT_PROVISIONED' ORDER BY created_at DESC LIMIT 1;`
    );
    assert.ok(auditRes.rows.length > 0, "Provisioning must create an audit log row");
    const log = auditRes.rows[0];
    assert.strictEqual(log.action, "ADMIN_ACCOUNT_PROVISIONED");
    assert.strictEqual(log.target_entity, "user_roles");
    assert.ok(log.diff.display_name, "Audit diff must record display_name");
    pass("Account provisioning creates immutable audit log entries with operator details in PostgreSQL");
  } catch (e) { fail("Provisioning audit trail", e); }

  try {
    // devAllowUnverified strictly fails in production
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    let caughtErr = null;
    try {
      await provisionAdminAccount({
        firebaseUid: "fake_prod_uid",
        phone: "+919811999999",
        displayName: "Prod Hacker",
        roleId: "super_operator",
        devAllowUnverified: true,
      });
    } catch (err) {
      caughtErr = err;
    }
    process.env.NODE_ENV = prevNodeEnv;

    assert.ok(caughtErr, "Must reject devAllowUnverified in production");
    assert.ok(caughtErr.message.includes("forbidden outside development"), "Error must state forbidden outside development");
    pass("devAllowUnverified is strictly forbidden in production mode");
  } catch (e) { fail("devAllowUnverified production prevention", e); }

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log("\n==================================================================");
  console.log(`🏁 PHASE 2D AUTH & SECURITY TEST COMPLETE: ${passedCount} Passed, ${failedCount} Failed`);
  console.log("==================================================================\n");

  if (server) server.close();
  await closePool();

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
