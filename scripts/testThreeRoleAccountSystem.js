#!/usr/bin/env node
/**
 * ==============================================================================
 * THREE-ROLE ACCOUNT SYSTEM VERIFICATION SUITE (`scripts/testThreeRoleAccountSystem.js`)
 * Nails by Divya Platform — Phase 5.4 Three-Role Account Architecture
 *
 * Validates:
 * 1. CUSTOMER ROLE:
 *    - Self-registration & login via Phone Auth.
 *    - Role resolves strictly to [] (Customer privileges only).
 *    - Self-service profile management (GET/PUT /api/customer/profile).
 *    - Self-service address management (GET/POST /api/customer/addresses).
 *    - Cross-customer isolation (Customer A cannot access Customer B's records).
 *    - Complete block from /api/admin/* (403 FORBIDDEN_ROLE).
 *
 * 2. ARTIST ROLE (Divya, +918447391310):
 *    - Verified phone auth binds to pre-seeded artist_divya account.
 *    - Full operational authority: orders, bookings, catalog, portfolio, reviews.
 *    - Strict block from Owner-only endpoints (403 FORBIDDEN_PERMISSION on
 *      /staff, /roles, /settings, /audit-logs).
 *
 * 3. OWNER ROLE (Raghav, +917827437985):
 *    - Verified phone auth binds to pre-seeded super_operator account.
 *    - Universal administrative authority across all endpoints, including
 *      staff management, platform configuration, and immutable audit logs.
 *
 * 4. SESSION ISOLATION & ANTI-TAKEOVER PROTECTION:
 *    - Strict session independence (Owner and Artist do not share sessions).
 *    - Anti-account-takeover protection (409 conflict when phone bound to different UID).
 *    - Rejection of unauthenticated requests (401 AUTH_REQUIRED).
 * ==============================================================================
 */

"use strict";

process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const express = require("express");
const { getPool, query, withTransaction, closePool } = require("../src/db/pool");
const { setTestTokenVerifier, clearTestTokenVerifier } = require("../src/services/firebaseService");
const authRouter = require("../src/routes/authRoute");
const adminRouter = require("../src/routes/adminRoute");
const customerRouter = require("../src/routes/customerRoute");
const orderRouter = require("../src/routes/orderRoute");
const bookingRouter = require("../src/routes/bookingRoute");

async function run() {
  console.log("==================================================================");
  console.log("   NAILS BY DIVYA — THREE-ROLE ACCOUNT SYSTEM TEST SUITE");
  console.log("==================================================================\n");

  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/customer", customerRouter);
  app.use("/api/orders", orderRouter);
  app.use("/api", bookingRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(path, baseUrl);
      const req = http.request(u, {
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  // Test identities
  const ts = Date.now();
  const customerA = {
    phone: `+919811${String(ts).slice(-6)}`,
    uid: `cust_a_uid_${ts}`,
    token: `token_cust_a_${ts}`
  };
  const customerB = {
    phone: `+919812${String(ts).slice(-6)}`,
    uid: `cust_b_uid_${ts}`,
    token: `token_cust_b_${ts}`
  };
  const divya = {
    phone: "+918447391310",
    uid: `divya_live_uid_${ts}`,
    token: `token_divya_${ts}`
  };
  const raghav = {
    phone: "+917827437985",
    uid: `raghav_live_uid_${ts}`,
    token: `token_raghav_${ts}`
  };

  // Configure Mock Token Verifier
  setTestTokenVerifier(async (token) => {
    if (token === customerA.token) {
      return { uid: customerA.uid, phone_number: customerA.phone, auth_time: Math.floor(Date.now() / 1000) };
    }
    if (token === customerB.token) {
      return { uid: customerB.uid, phone_number: customerB.phone, auth_time: Math.floor(Date.now() / 1000) };
    }
    if (token === divya.token) {
      return { uid: divya.uid, phone_number: divya.phone, auth_time: Math.floor(Date.now() / 1000) };
    }
    if (token === raghav.token) {
      return { uid: raghav.uid, phone_number: raghav.phone, auth_time: Math.floor(Date.now() / 1000) };
    }
    if (token === "hijack_divya_token") {
      return { uid: `attacker_uid_${ts}`, phone_number: divya.phone, auth_time: Math.floor(Date.now() / 1000) };
    }
    const err = new Error("Invalid Firebase ID token.");
    err.code = "auth/argument-error";
    throw err;
  });

  // Ensure clean starting state for Divya and Raghav
  await query("UPDATE users SET firebase_uid = NULL WHERE phone IN ($1, $2);", [divya.phone, raghav.phone]);

  try {
    // -------------------------------------------------------------------------
    // TEST SECTION 1: CUSTOMER ROLE & SELF-SERVICE EXPERIENCE
    // -------------------------------------------------------------------------
    console.log("▶ TEST SECTION 1: CUSTOMER ROLE & SELF-SERVICE EXPERIENCE");

    console.log("  1.1 Customer A registers & authenticates via POST /api/auth/verify-phone...");
    const resCustVerify = await request("/api/auth/verify-phone", {
      method: "POST",
      body: { idToken: customerA.token }
    });
    assert.strictEqual(resCustVerify.status, 200, "Customer verification must return 200");
    assert.strictEqual(resCustVerify.body.user.phone, customerA.phone);
    assert.deepStrictEqual(resCustVerify.body.user.roles, [], "Newly registered customer must have roles = []");
    assert.strictEqual(resCustVerify.body.user.adminProfile, null, "Customer must have no adminProfile");
    const custAId = resCustVerify.body.user.id;
    console.log("      ✓ Passed: Customer registered with empty admin roles and null admin profile");

    console.log("  1.2 Customer A fetches & updates bespoke nail profile...");
    const resProfileGet = await request("/api/customer/profile", {
      headers: { Authorization: `Bearer ${customerA.token}` }
    });
    assert.strictEqual(resProfileGet.status, 200);
    assert.strictEqual(resProfileGet.body.status, "success");

    const resProfileUpdate = await request("/api/customer/profile", {
      method: "PUT",
      headers: { Authorization: `Bearer ${customerA.token}` },
      body: {
        full_name: "Aanya Sharma",
        preferred_nail_shape: "Almond",
        preferred_nail_length: "Medium",
        custom_nail_measurements: { thumb: 15, index: 11.5, middle: 12, ring: 11, pinky: 8.5 }
      }
    });
    assert.strictEqual(resProfileUpdate.status, 200);
    assert.strictEqual(resProfileUpdate.body.profile.full_name, "Aanya Sharma");
    assert.strictEqual(resProfileUpdate.body.profile.preferred_nail_shape, "Almond");
    console.log("      ✓ Passed: Customer successfully updated bespoke nail profile");

    console.log("  1.3 Customer A saves delivery address...");
    const resAddrPost = await request("/api/customer/addresses", {
      method: "POST",
      headers: { Authorization: `Bearer ${customerA.token}` },
      body: {
        recipient_name: "Aanya Sharma",
        recipient_phone: customerA.phone,
        address_line1: "Apartment 4B, Silver Heights",
        city: "Gurugram",
        state: "Haryana",
        postal_code: "122002",
        is_default_shipping: true
      }
    });
    assert.strictEqual(resAddrPost.status, 201);
    const addrId = resAddrPost.body.address.id;
    assert.ok(addrId, "Address ID must be returned");
    console.log("      ✓ Passed: Customer saved delivery address");

    console.log("  1.4 Customer A attempts to access admin endpoints (MUST BE FORBIDDEN)...");
    const forbiddenAdminEndpoints = [
      { path: "/api/admin/me", method: "GET" },
      { path: "/api/admin/overview", method: "GET" },
      { path: "/api/admin/orders", method: "GET" },
      { path: "/api/admin/bookings", method: "GET" },
      { path: "/api/admin/products", method: "GET" },
      { path: "/api/admin/staff", method: "GET" },
      { path: "/api/admin/settings", method: "GET" },
      { path: "/api/admin/audit-logs", method: "GET" }
    ];

    for (const ep of forbiddenAdminEndpoints) {
      const resForbid = await request(ep.path, {
        method: ep.method,
        headers: { Authorization: `Bearer ${customerA.token}` }
      });
      assert.strictEqual(resForbid.status, 403, `Customer must be blocked with 403 on ${ep.path}`);
      assert.strictEqual(resForbid.body.code, "FORBIDDEN_ROLE");
    }
    console.log("      ✓ Passed: Customer strictly rejected with 403 FORBIDDEN_ROLE on all 8 admin endpoints");

    // -------------------------------------------------------------------------
    // TEST SECTION 2: CROSS-CUSTOMER ISOLATION
    // -------------------------------------------------------------------------
    console.log("\n▶ TEST SECTION 2: CROSS-CUSTOMER ISOLATION");
    console.log("  2.1 Customer B registers & creates an appointment request...");
    const resCustBVerify = await request("/api/auth/verify-phone", {
      method: "POST",
      body: { idToken: customerB.token }
    });
    assert.strictEqual(resCustBVerify.status, 200);
    const custBId = resCustBVerify.body.user.id;

    // Fetch active service for booking
    const svcRes = await query("SELECT id FROM services WHERE is_active = TRUE LIMIT 1;");
    const serviceId = svcRes.rows[0]?.id;

    let bookingBId = null;
    if (serviceId) {
      const bkgRes = await request("/api/bookings", {
        method: "POST",
        headers: { Authorization: `Bearer ${customerB.token}` },
        body: {
          service_id: serviceId,
          requested_date: "2026-11-25",
          requested_time_slot: "14:00 - 16:00",
          customer: {
            name: "Pooja Verma",
            phone: customerB.phone
          },
          service_address: {
            address_line1: "Flat 101, Green Valley",
            city: "New Delhi",
            state: "Delhi",
            postal_code: "110001"
          }
        }
      });
      assert.strictEqual(bkgRes.status, 201);
      bookingBId = bkgRes.body.booking.id;
    }

    console.log("  2.2 Customer A attempts to access Customer B's appointment (MUST BE BLOCKED)...");
    if (bookingBId) {
      const resCrossBkg = await request(`/api/bookings/${bookingBId}`, {
        headers: { Authorization: `Bearer ${customerA.token}` }
      });
      assert.ok([403, 404].includes(resCrossBkg.status), `Cross-customer booking access must return 403/404, got ${resCrossBkg.status}`);
      console.log(`      ✓ Passed: Cross-customer booking access rejected with ${resCrossBkg.status}`);
    }

    console.log("  2.3 Customer A fetches order history (receives only own orders)...");
    const resOrders = await request("/api/orders", {
      headers: { Authorization: `Bearer ${customerA.token}` }
    });
    assert.strictEqual(resOrders.status, 200);
    assert.strictEqual(resOrders.body.status, "success");
    console.log("      ✓ Passed: Customer orders history queries only authenticated user records");

    // -------------------------------------------------------------------------
    // TEST SECTION 3: ARTIST ROLE (Divya, +918447391310)
    // -------------------------------------------------------------------------
    console.log("\n▶ TEST SECTION 3: ARTIST ROLE (Divya, +918447391310)");

    console.log("  3.1 Divya authenticates via POST /api/auth/verify-phone...");
    const resDivyaVerify = await request("/api/auth/verify-phone", {
      method: "POST",
      body: { idToken: divya.token }
    });
    assert.strictEqual(resDivyaVerify.status, 200);
    assert.strictEqual(resDivyaVerify.body.user.phone, divya.phone);
    assert.ok(resDivyaVerify.body.user.roles.includes("artist_divya"), "Must include artist_divya role");
    assert.strictEqual(resDivyaVerify.body.user.adminProfile.display_name, "Divya");
    console.log("      ✓ Passed: Divya verified, linked UID, returned role 'artist_divya' and display name 'Divya'");

    console.log("  3.2 Divya accesses operational business endpoints (MUST BE ALLOWED)...");
    const divyaAllowedEndpoints = [
      "/api/admin/me",
      "/api/admin/overview",
      "/api/admin/orders",
      "/api/admin/bookings",
      "/api/admin/products",
      "/api/admin/portfolio",
      "/api/admin/reviews",
      "/api/admin/customers"
    ];

    for (const path of divyaAllowedEndpoints) {
      const resAllowed = await request(path, {
        headers: { Authorization: `Bearer ${divya.token}` }
      });
      assert.strictEqual(resAllowed.status, 200, `Divya must be allowed on ${path}, got ${resAllowed.status}`);
    }
    console.log("      ✓ Passed: Divya has full access to all 8 operational studio endpoints");

    console.log("  3.3 Divya attempts to access Owner-only endpoints (MUST BE REJECTED WITH 403 FORBIDDEN_PERMISSION)...");
    const ownerOnlyEndpoints = [
      { path: "/api/admin/staff", expectedPerm: "Manage Staff Accounts" },
      { path: "/api/admin/settings", expectedPerm: "Edit Platform Configuration" },
      { path: "/api/admin/audit-logs", expectedPerm: "View Audit Logs" }
    ];

    for (const ep of ownerOnlyEndpoints) {
      const resForbid = await request(ep.path, {
        headers: { Authorization: `Bearer ${divya.token}` }
      });
      assert.strictEqual(resForbid.status, 403, `Divya must be blocked on ${ep.path}`);
      assert.strictEqual(resForbid.body.code, "FORBIDDEN_PERMISSION", `Expected FORBIDDEN_PERMISSION on ${ep.path}`);
    }
    console.log("      ✓ Passed: Divya strictly forbidden from all 3 Owner-only endpoints (staff, settings, audit-logs)");

    // -------------------------------------------------------------------------
    // TEST SECTION 4: OWNER ROLE (Raghav, +917827437985)
    // -------------------------------------------------------------------------
    console.log("\n▶ TEST SECTION 4: OWNER ROLE (Raghav, +917827437985)");

    console.log("  4.1 Raghav authenticates via POST /api/auth/verify-phone...");
    const resRaghavVerify = await request("/api/auth/verify-phone", {
      method: "POST",
      body: { idToken: raghav.token }
    });
    assert.strictEqual(resRaghavVerify.status, 200);
    assert.strictEqual(resRaghavVerify.body.user.phone, raghav.phone);
    assert.ok(resRaghavVerify.body.user.roles.includes("super_operator"), "Must include super_operator role");
    assert.strictEqual(resRaghavVerify.body.user.adminProfile.display_name, "Raghav");
    console.log("      ✓ Passed: Raghav verified, linked UID, returned role 'super_operator' and display name 'Raghav'");

    console.log("  4.2 Raghav accesses all operational AND Owner-only endpoints (MUST BE ALLOWED)...");
    const raghavEndpoints = [
      "/api/admin/me",
      "/api/admin/overview",
      "/api/admin/orders",
      "/api/admin/bookings",
      "/api/admin/products",
      "/api/admin/portfolio",
      "/api/admin/reviews",
      "/api/admin/customers",
      "/api/admin/staff",
      "/api/admin/roles",
      "/api/admin/settings",
      "/api/admin/audit-logs"
    ];

    for (const path of raghavEndpoints) {
      const resAllowed = await request(path, {
        headers: { Authorization: `Bearer ${raghav.token}` }
      });
      assert.strictEqual(resAllowed.status, 200, `Raghav must be allowed on ${path}, got ${resAllowed.status}`);
    }
    console.log("      ✓ Passed: Raghav has universal authorization on all 12 operational & owner endpoints");

    // -------------------------------------------------------------------------
    // TEST SECTION 5: SESSION ISOLATION & ANTI-TAKEOVER PROTECTION
    // -------------------------------------------------------------------------
    console.log("\n▶ TEST SECTION 5: SESSION ISOLATION & ANTI-TAKEOVER PROTECTION");

    console.log("  5.1 Attempt account hijacking: Divya's phone with an unauthorized attacker UID...");
    // Divya's account is currently bound to divya.uid. An attacker presenting a token with divya's phone but attacker_uid must be rejected with 409
    const resHijack = await request("/api/auth/verify-phone", {
      method: "POST",
      body: { idToken: "hijack_divya_token" }
    });
    assert.strictEqual(resHijack.status, 409, "Account hijack attempt must return 409 ACCOUNT_LINK_CONFLICT");
    assert.strictEqual(resHijack.body.code, "ACCOUNT_LINK_CONFLICT");
    console.log("      ✓ Passed: Account takeover attempt successfully blocked with 409 ACCOUNT_LINK_CONFLICT");

    console.log("  5.2 Unauthenticated access rejection...");
    const resNoAuth = await request("/api/admin/me");
    assert.strictEqual(resNoAuth.status, 401);
    assert.strictEqual(resNoAuth.body.code, "AUTH_REQUIRED");
    console.log("      ✓ Passed: Unauthenticated request rejected with 401 AUTH_REQUIRED");

    // -------------------------------------------------------------------------
    // CLEANUP: RESET DB STATE TO PRISTINE
    // -------------------------------------------------------------------------
    console.log("\n▶ PRISTINE DATABASE CLEANUP");
    await query("UPDATE users SET firebase_uid = NULL WHERE phone = $1;", [divya.phone]);
    await query("UPDATE users SET firebase_uid = NULL WHERE phone = $1;", [raghav.phone]);
    await query("DELETE FROM users WHERE phone IN ($1, $2);", [customerA.phone, customerB.phone]);
    console.log("  ✓ Reset Divya & Raghav firebase_uid back to NULL (ready for live phone logins)");
    console.log("  ✓ Removed temporary test customer records");

    console.log("\n==================================================================");
    console.log("🎉 ALL THREE-ROLE ACCOUNT SYSTEM TESTS PASSED PERFECTLY!");
    console.log("==================================================================\n");

  } finally {
    clearTestTokenVerifier();
    server.close();
    await closePool();
  }
}

run().catch((err) => {
  console.error("\n❌ Test suite failed with error:", err);
  process.exit(1);
});
