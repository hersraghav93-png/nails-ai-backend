#!/usr/bin/env node
/**
 * ==============================================================================
 * ACCOUNT SWITCHING & SESSION ISOLATION VERIFICATION SUITE
 * (`scripts/testAccountSwitchingAndSessionIsolation.js`)
 * Nails by Divya Platform — Phase 5.4.1
 *
 * Explicitly tests:
 * 1. Rapid, sequential switching between OWNER, CUSTOMER, and ARTIST accounts
 *    simulating real browser usage.
 * 2. Complete clearance of privilege upon logout (stale tokens / role bleeding).
 * 3. Rejection of customer from all administrative endpoints.
 * 4. Rejection of artist from owner-only endpoints (staff, settings, audit-logs).
 * 5. Anti-takeover conflict defense (409) when foreign UID claims registered phones.
 * 6. Flawless privilege restoration when switching back to Owner.
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
  console.log("   NAILS BY DIVYA — ACCOUNT SWITCHING & SESSION ISOLATION TEST");
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

  const ts = Date.now();
  const owner = {
    phone: "+917827437985",
    uid: `owner_uid_${ts}`,
    token: `token_owner_${ts}`,
    displayName: "Raghav"
  };
  const customer = {
    phone: `+919815${String(ts).slice(-6)}`,
    uid: `cust_switch_uid_${ts}`,
    token: `token_cust_switch_${ts}`,
    displayName: "Customer"
  };
  const artist = {
    phone: "+918447391310",
    uid: `artist_uid_${ts}`,
    token: `token_artist_${ts}`,
    displayName: "Divya"
  };

  // Configure Mock Verifier
  setTestTokenVerifier(async (token) => {
    if (token === owner.token) {
      return { uid: owner.uid, phone_number: owner.phone, auth_time: Math.floor(Date.now() / 1000) };
    }
    if (token === customer.token) {
      return { uid: customer.uid, phone_number: customer.phone, auth_time: Math.floor(Date.now() / 1000) };
    }
    if (token === artist.token) {
      return { uid: artist.uid, phone_number: artist.phone, auth_time: Math.floor(Date.now() / 1000) };
    }
    if (token === "attacker_hijack_token") {
      return { uid: `attacker_uid_${ts}`, phone_number: owner.phone, auth_time: Math.floor(Date.now() / 1000) };
    }
    const err = new Error("Invalid Firebase ID token.");
    err.code = "auth/argument-error";
    throw err;
  });

  // Ensure clean starting state for Divya and Raghav
  await query("UPDATE users SET firebase_uid = NULL WHERE phone IN ($1, $2);", [owner.phone, artist.phone]);

  try {
    // -------------------------------------------------------------------------
    // STEP 1: INITIAL STATE (NO SESSION)
    // -------------------------------------------------------------------------
    console.log("▶ STEP 1: Initial State (No Session)");
    const resNoToken = await request("/api/admin/me");
    assert.strictEqual(resNoToken.status, 401);
    assert.strictEqual(resNoToken.body.code, "AUTH_REQUIRED");
    console.log("  ✓ Passed: Unauthenticated request rejected with 401 AUTH_REQUIRED");

    // -------------------------------------------------------------------------
    // STEP 2: LOGIN AS OWNER (RAGHAV)
    // -------------------------------------------------------------------------
    console.log("\n▶ STEP 2: Authenticate as OWNER (Raghav, +917827437985)");
    const resOwnerLogin = await request("/api/auth/verify-phone", {
      method: "POST",
      body: { idToken: owner.token }
    });
    assert.strictEqual(resOwnerLogin.status, 200);
    assert.ok(resOwnerLogin.body.user.roles.includes("super_operator"), "Owner must hold super_operator role");
    assert.strictEqual(resOwnerLogin.body.user.adminProfile.display_name, "Raghav");

    // Verify Owner has access to staff, settings, audit-logs
    const resOwnerStaff = await request("/api/admin/staff", { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.strictEqual(resOwnerStaff.status, 200, "Owner can access staff");

    const resOwnerSettings = await request("/api/admin/settings", { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.strictEqual(resOwnerSettings.status, 200, "Owner can access settings");

    const resOwnerAudit = await request("/api/admin/audit-logs", { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.strictEqual(resOwnerAudit.status, 200, "Owner can access audit-logs");
    console.log("  ✓ Passed: Owner authenticated with universal permissions on staff, settings, audit-logs");

    // -------------------------------------------------------------------------
    // STEP 3: SWITCH TO CUSTOMER IN SAME CLIENT BROWSER
    // -------------------------------------------------------------------------
    console.log("\n▶ STEP 3: Switch to CUSTOMER (Aanya, " + customer.phone + ") in Same Browser");
    // Simulate client-side logout: Owner token discarded. New token obtained for customer.
    const resCustLogin = await request("/api/auth/verify-phone", {
      method: "POST",
      body: { idToken: customer.token }
    });
    assert.strictEqual(resCustLogin.status, 200);
    assert.deepStrictEqual(resCustLogin.body.user.roles, [], "Customer roles must be strictly empty []");
    assert.strictEqual(resCustLogin.body.user.adminProfile, null);

    // Customer can access customer profile
    const resCustProfile = await request("/api/customer/profile", { headers: { Authorization: `Bearer ${customer.token}` } });
    assert.strictEqual(resCustProfile.status, 200);

    // CRITICAL ISOLATION CHECK: Customer MUST NOT inherit any of Owner's privileges!
    const resCustTryMe = await request("/api/admin/me", { headers: { Authorization: `Bearer ${customer.token}` } });
    assert.strictEqual(resCustTryMe.status, 403);
    assert.strictEqual(resCustTryMe.body.code, "FORBIDDEN_ROLE");

    const resCustTryStaff = await request("/api/admin/staff", { headers: { Authorization: `Bearer ${customer.token}` } });
    assert.strictEqual(resCustTryStaff.status, 403);
    assert.strictEqual(resCustTryStaff.body.code, "FORBIDDEN_ROLE");

    const resCustTrySettings = await request("/api/admin/settings", { headers: { Authorization: `Bearer ${customer.token}` } });
    assert.strictEqual(resCustTrySettings.status, 403);
    assert.strictEqual(resCustTrySettings.body.code, "FORBIDDEN_ROLE");

    const resCustTryAudit = await request("/api/admin/audit-logs", { headers: { Authorization: `Bearer ${customer.token}` } });
    assert.strictEqual(resCustTryAudit.status, 403);
    assert.strictEqual(resCustTryAudit.body.code, "FORBIDDEN_ROLE");
    console.log("  ✓ Passed: Customer strictly forbidden from all admin routes (403 FORBIDDEN_ROLE). Zero role bleeding.");

    // -------------------------------------------------------------------------
    // STEP 4: SWITCH TO ARTIST (DIVYA, +918447391310) IN SAME BROWSER
    // -------------------------------------------------------------------------
    console.log("\n▶ STEP 4: Switch to ARTIST (Divya, +918447391310) in Same Browser");
    const resArtistLogin = await request("/api/auth/verify-phone", {
      method: "POST",
      body: { idToken: artist.token }
    });
    assert.strictEqual(resArtistLogin.status, 200);
    assert.ok(resArtistLogin.body.user.roles.includes("artist_divya"), "Must hold artist_divya role");
    assert.ok(!resArtistLogin.body.user.roles.includes("super_operator"), "Artist must NOT hold super_operator");

    // Divya can access operational routes
    const resArtistMe = await request("/api/admin/me", { headers: { Authorization: `Bearer ${artist.token}` } });
    assert.strictEqual(resArtistMe.status, 200);

    const resArtistOrders = await request("/api/admin/orders", { headers: { Authorization: `Bearer ${artist.token}` } });
    assert.strictEqual(resArtistOrders.status, 200);

    const resArtistProducts = await request("/api/admin/products", { headers: { Authorization: `Bearer ${artist.token}` } });
    assert.strictEqual(resArtistProducts.status, 200);

    // CRITICAL ISOLATION CHECK: Divya CANNOT access Owner-only routes!
    const resArtistTryStaff = await request("/api/admin/staff", { headers: { Authorization: `Bearer ${artist.token}` } });
    assert.strictEqual(resArtistTryStaff.status, 403);
    assert.strictEqual(resArtistTryStaff.body.code, "FORBIDDEN_PERMISSION");

    const resArtistTrySettings = await request("/api/admin/settings", { headers: { Authorization: `Bearer ${artist.token}` } });
    assert.strictEqual(resArtistTrySettings.status, 403);
    assert.strictEqual(resArtistTrySettings.body.code, "FORBIDDEN_PERMISSION");

    const resArtistTryAudit = await request("/api/admin/audit-logs", { headers: { Authorization: `Bearer ${artist.token}` } });
    assert.strictEqual(resArtistTryAudit.status, 403);
    assert.strictEqual(resArtistTryAudit.body.code, "FORBIDDEN_PERMISSION");
    console.log("  ✓ Passed: Artist has operational authority but is strictly forbidden from Owner controls (403 FORBIDDEN_PERMISSION).");

    // -------------------------------------------------------------------------
    // STEP 5: ANTI-TAKEOVER CONFLICT PROTECTION
    // -------------------------------------------------------------------------
    console.log("\n▶ STEP 5: Account Conflict Defense (Attacker claims Owner Phone with Foreign UID)");
    const resHijack = await request("/api/auth/verify-phone", {
      method: "POST",
      body: { idToken: "attacker_hijack_token" }
    });
    assert.strictEqual(resHijack.status, 409);
    assert.strictEqual(resHijack.body.code, "ACCOUNT_LINK_CONFLICT");
    console.log("  ✓ Passed: Anti-takeover conflict check rejected foreign UID binding with 409 ACCOUNT_LINK_CONFLICT");

    // -------------------------------------------------------------------------
    // STEP 6: SWITCH BACK TO OWNER (RAGHAV)
    // -------------------------------------------------------------------------
    console.log("\n▶ STEP 6: Switch Back to OWNER (Raghav) in Same Browser");
    const resOwnerReLogin = await request("/api/auth/verify-phone", {
      method: "POST",
      body: { idToken: owner.token }
    });
    assert.strictEqual(resOwnerReLogin.status, 200);
    assert.ok(resOwnerReLogin.body.user.roles.includes("super_operator"));

    // Full privileges intact
    const resOwnerReStaff = await request("/api/admin/staff", { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.strictEqual(resOwnerReStaff.status, 200);
    const resOwnerReSettings = await request("/api/admin/settings", { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.strictEqual(resOwnerReSettings.status, 200);
    console.log("  ✓ Passed: Owner re-authenticated with full privileges cleanly restored.");

    // -------------------------------------------------------------------------
    // CLEANUP
    // -------------------------------------------------------------------------
    console.log("\n▶ PRISTINE DATABASE CLEANUP");
    await query("UPDATE users SET firebase_uid = NULL WHERE phone IN ($1, $2);", [owner.phone, artist.phone]);
    await query("DELETE FROM users WHERE phone = $1;", [customer.phone]);
    console.log("  ✓ Cleaned up test customer and reset admin UIDs to NULL");

    console.log("\n==================================================================");
    console.log("🎉 ALL ACCOUNT SWITCHING & SESSION ISOLATION TESTS PASSED!");
    console.log("==================================================================\n");

  } finally {
    clearTestTokenVerifier();
    server.close();
    await closePool();
  }
}

run().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
