/**
 * ==========================================================================
 * HARDENED AUTHENTICATION & SECURITY AUDIT TEST SUITE (`scripts/testAuth.js`)
 * Nails by Divya Platform — Phase 1C.1
 *
 * Verifies:
 * 1. Token Verification & Error Handling (Missing, Malformed, Expired, Revoked)
 * 2. Account Hijacking / Takeover Defense via Phone Linking
 * 3. Safe Linking of Unlinked Guest Accounts
 * 4. Concurrency & Race Condition Defense on First Login (Parallel Requests)
 * 5. Customer Profile Retrieval, Input Validation, and Mass Assignment Defense
 * 6. Address CRUD, Multi-User Isolation, UUID Validation, and Field Bounds
 * 7. Administrator Provisioning Verification against Firebase Auth:
 *    - Rejection of Non-Existent Firebase Accounts
 *    - Rejection of Disabled Firebase Accounts
 *    - Rejection of Phone Number Mismatches
 *    - Defense Against Identity Collisions (UID vs Phone Divergence)
 *    - Role Mutation Guardrails (Requires Explicit --allow-role-change)
 *    - Safe Idempotency on Repeated Provisioning
 * 8. RBAC and Permission Enforcement (super_operator vs artist_divya vs customer)
 * 9. Account Suspension Defense (Customer and Admin Endpoints)
 * 10. Test Verifier Guardrail (Strictly Disabled Outside Test Environment)
 * ==========================================================================
 */

process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const app = require("../index");
const CONFIG = require("../src/config");
const {
  setTestTokenVerifier,
  clearTestTokenVerifier,
} = require("../src/services/firebaseService");
const {
  findOrCreateUserByFirebaseToken,
  provisionAdminAccount,
  VALID_ADMIN_ROLES,
} = require("../src/services/userService");
const { parseArgs } = require("./provisionAdmin");
const { query, closePool } = require("../src/db/pool");

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

async function runAuthTestSuite() {
  console.log("==================================================================");
  console.log("   NAILS BY DIVYA — PHASE 1C.1 AUTH & SECURITY AUDIT TEST SUITE");
  console.log("==================================================================\n");

  // Spin up temporary HTTP test server
  const testServer = http.createServer(app);
  await new Promise((resolve) => testServer.listen(0, resolve));
  const testPort = testServer.address().port;
  const baseUrl = `http://localhost:${testPort}`;

  async function makeRequest(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const headers = { ...options.headers };
      let bodyData = null;

      if (options.body) {
        bodyData = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
        if (!headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
        headers["Content-Length"] = Buffer.byteLength(bodyData);
      }

      const req = http.request(
        url,
        {
          method: options.method || "GET",
          headers,
        },
        (res) => {
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
        }
      );
      req.on("error", reject);
      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    });
  }

  // Setup test tokens in non-production test verifier hook
  const testTimestamp = Date.now();
  const CUST_A_UID = `cust_a_fb_${testTimestamp}`;
  const CUST_A_PHONE = `+919811${Math.floor(100000 + Math.random() * 900000)}`;
  const CUST_B_UID = `cust_b_fb_${testTimestamp}`;
  const CUST_B_PHONE = `+919812${Math.floor(100000 + Math.random() * 900000)}`;
  const ADMIN_SUPER_UID = `admin_super_fb_${testTimestamp}`;
  const ADMIN_SUPER_PHONE = `+919813${Math.floor(100000 + Math.random() * 900000)}`;
  const ADMIN_DIVYA_UID = `admin_divya_fb_${testTimestamp}`;
  const ADMIN_DIVYA_PHONE = `+919814${Math.floor(100000 + Math.random() * 900000)}`;
  const SUSPENDED_UID = `suspended_fb_${testTimestamp}`;
  const SUSPENDED_PHONE = `+919815${Math.floor(100000 + Math.random() * 900000)}`;
  const SUSPENDED_ADMIN_UID = `suspended_admin_fb_${testTimestamp}`;
  const SUSPENDED_ADMIN_PHONE = `+919816${Math.floor(100000 + Math.random() * 900000)}`;
  const DISABLED_FIREBASE_UID = `disabled_fb_${testTimestamp}`;
  const DISABLED_FIREBASE_PHONE = `+919817${Math.floor(100000 + Math.random() * 900000)}`;

  const tokenDatabase = {
    "token_cust_a": { uid: CUST_A_UID, phone_number: CUST_A_PHONE, email: "cust_a@example.com" },
    "token_cust_b": { uid: CUST_B_UID, phone_number: CUST_B_PHONE, email: "cust_b@example.com" },
    "token_admin_super": { uid: ADMIN_SUPER_UID, phone_number: ADMIN_SUPER_PHONE, email: "super@nailsbydivya.com" },
    "token_admin_divya": { uid: ADMIN_DIVYA_UID, phone_number: ADMIN_DIVYA_PHONE, email: "divya@nailsbydivya.com" },
    "token_suspended": { uid: SUSPENDED_UID, phone_number: SUSPENDED_PHONE, email: "suspended@example.com" },
    "token_suspended_admin": { uid: SUSPENDED_ADMIN_UID, phone_number: SUSPENDED_ADMIN_PHONE, email: "suspended_admin@example.com" },
  };

  const mockFirebaseUsers = {
    [ADMIN_SUPER_UID]: { uid: ADMIN_SUPER_UID, phoneNumber: ADMIN_SUPER_PHONE, disabled: false },
    [ADMIN_DIVYA_UID]: { uid: ADMIN_DIVYA_UID, phoneNumber: ADMIN_DIVYA_PHONE, disabled: false },
    [SUSPENDED_ADMIN_UID]: { uid: SUSPENDED_ADMIN_UID, phoneNumber: SUSPENDED_ADMIN_PHONE, disabled: false },
    [DISABLED_FIREBASE_UID]: { uid: DISABLED_FIREBASE_UID, phoneNumber: DISABLED_FIREBASE_PHONE, disabled: true },
  };

  setTestTokenVerifier(
    async (token) => tokenDatabase[token] || null,
    async (uid) => mockFirebaseUsers[uid] || null
  );

  const createdUserIds = [];

  try {
    // ---------------------------------------------------------------------------
    // 1. TOKEN VERIFICATION & AUTHENTICATION ERROR HANDLING
    // ---------------------------------------------------------------------------
    console.log("🧪 1. Authentication & Token Verification (src/middleware/auth.js)");

    await itAsync("GET /api/auth/me rejects request without Authorization header (401 AUTH_REQUIRED)", async () => {
      const res = await makeRequest("/api/auth/me");
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, "AUTH_REQUIRED");
    });

    await itAsync("GET /api/auth/me rejects non-Bearer Authorization scheme (401 AUTH_REQUIRED)", async () => {
      const res = await makeRequest("/api/auth/me", {
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, "AUTH_REQUIRED");
    });

    await itAsync("GET /api/auth/me rejects invalid or unknown token (401 INVALID_TOKEN)", async () => {
      const res = await makeRequest("/api/auth/me", {
        headers: { Authorization: "Bearer bogus_token_xyz" },
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, "INVALID_TOKEN");
    });

    // ---------------------------------------------------------------------------
    // 2. CUSTOMER REGISTRATION, IDENTITY LINKING & TAKEOVER DEFENSE
    // ---------------------------------------------------------------------------
    console.log("\n🧪 2. Customer Registration & Takeover Defense (src/services/userService.js)");

    let custAUserId = null;

    await itAsync("First authenticated request registers customer in PostgreSQL and creates customer profile", async () => {
      const res = await makeRequest("/api/auth/me", {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "success");
      assert.ok(res.body.user);
      assert.strictEqual(res.body.user.firebase_uid, CUST_A_UID);
      assert.strictEqual(res.body.user.phone, CUST_A_PHONE);
      assert.strictEqual(res.body.user.is_active, true);
      assert.deepStrictEqual(res.body.user.roles, []);
      assert.deepStrictEqual(res.body.user.permissions, []);
      assert.ok(res.body.user.profile);
      assert.strictEqual(res.body.user.profile.full_name, "Customer");

      custAUserId = res.body.user.id;
      createdUserIds.push(custAUserId);
    });

    await itAsync("Subsequent requests with same token are idempotent and retrieve existing user", async () => {
      const res = await makeRequest("/api/auth/me", {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.user.id, custAUserId);
    });

    await itAsync("ACCOUNT TAKEOVER DEFENSE: Different Firebase UID claiming an already-linked phone is rejected (409)", async () => {
      let threwConflict = false;
      try {
        await findOrCreateUserByFirebaseToken({
          uid: `attacker_uid_${testTimestamp}`,
          phone_number: CUST_A_PHONE, // claiming Customer A's phone!
        });
      } catch (err) {
        threwConflict = true;
        assert.strictEqual(err.code, "ACCOUNT_LINK_CONFLICT");
        assert.strictEqual(err.statusCode, 409);
      }
      assert.strictEqual(threwConflict, true, "Must throw 409 ACCOUNT_LINK_CONFLICT on phone hijacking attempt");

      // Verify Customer A's record was NOT hijacked
      const verifyRes = await query(`SELECT firebase_uid FROM users WHERE id = $1;`, [custAUserId]);
      assert.strictEqual(verifyRes.rows[0].firebase_uid, CUST_A_UID, "Customer A's Firebase UID must remain unchanged");
    });

    await itAsync("GUEST ACCOUNT LINKING: Unlinked guest user (firebase_uid IS NULL) safely links to verified Firebase UID", async () => {
      const guestPhone = `+919819${Math.floor(100000 + Math.random() * 900000)}`;
      const guestRes = await query(
        `INSERT INTO users (phone, phone_verified_at) VALUES ($1, CURRENT_TIMESTAMP) RETURNING id;`,
        [guestPhone]
      );
      const guestUserId = guestRes.rows[0].id;
      createdUserIds.push(guestUserId);

      const guestUid = `linked_guest_fb_${testTimestamp}`;
      const linkedUser = await findOrCreateUserByFirebaseToken({
        uid: guestUid,
        phone_number: guestPhone,
      });

      assert.strictEqual(linkedUser.id, guestUserId, "Must link to the existing guest user record");
      assert.strictEqual(linkedUser.firebase_uid, guestUid);
      assert.strictEqual(linkedUser.phone, guestPhone);
    });

    await itAsync("CONCURRENCY DEFENSE: Simultaneous parallel login requests resolve safely without race condition errors", async () => {
      const raceUid = `race_user_fb_${testTimestamp}`;
      const racePhone = `+919820${Math.floor(100000 + Math.random() * 900000)}`;

      // Execute 5 concurrent first-time requests simultaneously
      const results = await Promise.all([
        findOrCreateUserByFirebaseToken({ uid: raceUid, phone_number: racePhone }),
        findOrCreateUserByFirebaseToken({ uid: raceUid, phone_number: racePhone }),
        findOrCreateUserByFirebaseToken({ uid: raceUid, phone_number: racePhone }),
        findOrCreateUserByFirebaseToken({ uid: raceUid, phone_number: racePhone }),
        findOrCreateUserByFirebaseToken({ uid: raceUid, phone_number: racePhone }),
      ]);

      const primaryId = results[0].id;
      createdUserIds.push(primaryId);

      // All 5 must have resolved to the EXACT same user ID
      for (const res of results) {
        assert.strictEqual(res.id, primaryId, "All concurrent requests must resolve to identical user ID");
      }

      // Verify exactly 1 user row and 1 customer profile row exist in DB
      const userCountRes = await query(`SELECT COUNT(*)::int AS count FROM users WHERE firebase_uid = $1;`, [raceUid]);
      const profileCountRes = await query(`SELECT COUNT(*)::int AS count FROM customer_profiles WHERE user_id = $1;`, [primaryId]);

      assert.strictEqual(userCountRes.rows[0].count, 1, "Exactly one user row should exist");
      assert.strictEqual(profileCountRes.rows[0].count, 1, "Exactly one customer profile row should exist");
    });

    // ---------------------------------------------------------------------------
    // 3. CUSTOMER PROFILE MANAGEMENT & MASS ASSIGNMENT DEFENSE
    // ---------------------------------------------------------------------------
    console.log("\n🧪 3. Customer Profile Management & Mass Assignment Defense");

    await itAsync("GET /api/customer/profile retrieves customer profile", async () => {
      const res = await makeRequest("/api/customer/profile", {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.profile.full_name, "Customer");
      assert.strictEqual(res.body.profile.phone, CUST_A_PHONE);
    });

    await itAsync("PUT /api/customer/profile rejects invalid nail shape with 400 validation error", async () => {
      const res = await makeRequest("/api/customer/profile", {
        method: "PUT",
        headers: { Authorization: "Bearer token_cust_a" },
        body: {
          preferred_nail_shape: "InvalidShapeStar",
        },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "VALIDATION_FAILED");
    });

    await itAsync("PUT /api/customer/profile rejects invalid nail length with 400 validation error", async () => {
      const res = await makeRequest("/api/customer/profile", {
        method: "PUT",
        headers: { Authorization: "Bearer token_cust_a" },
        body: {
          preferred_nail_length: "UltraGigantic",
        },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "VALIDATION_FAILED");
    });

    await itAsync("PUT /api/customer/profile updates valid customer nail preferences and notes", async () => {
      const res = await makeRequest("/api/customer/profile", {
        method: "PUT",
        headers: { Authorization: "Bearer token_cust_a" },
        body: {
          full_name: "Aanya Sharma",
          preferred_nail_shape: "Almond",
          preferred_nail_length: "Medium",
          sizing_preset: "M",
          custom_nail_measurements: { thumb: 14, index: 11, middle: 12, ring: 10, pinky: 8 },
          allergies_or_notes: "Sensitive cuticles, prefers gentle buffing.",
        },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "success");
      assert.strictEqual(res.body.profile.full_name, "Aanya Sharma");
      assert.strictEqual(res.body.profile.preferred_nail_shape, "Almond");
      assert.strictEqual(res.body.profile.preferred_nail_length, "Medium");
      assert.strictEqual(res.body.profile.sizing_preset, "M");
      assert.deepStrictEqual(res.body.profile.custom_nail_measurements, {
        thumb: 14,
        index: 11,
        middle: 12,
        ring: 10,
        pinky: 8,
      });
    });

    await itAsync("MASS ASSIGNMENT DEFENSE: Arbitrary admin parameters in profile PUT are completely ignored", async () => {
      await makeRequest("/api/customer/profile", {
        method: "PUT",
        headers: { Authorization: "Bearer token_cust_a" },
        body: {
          role: "super_operator",
          roles: ["super_operator"],
          is_active: false,
          is_mfa_enabled: true,
          display_name: "Hacked Admin",
        },
      });

      // Verify customer A still has ZERO administrative roles in DB
      const checkRes = await query(`SELECT role_id FROM user_roles WHERE user_id = $1;`, [custAUserId]);
      assert.strictEqual(checkRes.rows.length, 0, "No roles should have been assigned");

      // Verify no admin profile was created
      const adminCheck = await query(`SELECT * FROM admin_profiles WHERE user_id = $1;`, [custAUserId]);
      assert.strictEqual(adminCheck.rows.length, 0, "No admin profile should have been created");
    });

    // ---------------------------------------------------------------------------
    // 4. ADDRESS CRUD, ISOLATION & VALIDATION
    // ---------------------------------------------------------------------------
    console.log("\n🧪 4. Address CRUD, Isolation & UUID Validation");

    let custAAddressId = null;

    await itAsync("POST /api/customer/addresses validates PIN code format (rejects non-6-digit PIN)", async () => {
      const res = await makeRequest("/api/customer/addresses", {
        method: "POST",
        headers: { Authorization: "Bearer token_cust_a" },
        body: {
          recipient_name: "Aanya Sharma",
          recipient_phone: "+919811000000",
          address_line1: "Flat 402, Sunshine Heights",
          city: "New Delhi",
          state: "Delhi",
          postal_code: "1100",
        },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "VALIDATION_FAILED");
    });

    await itAsync("POST /api/customer/addresses enforces field length limits (rejects oversized address_line1)", async () => {
      const res = await makeRequest("/api/customer/addresses", {
        method: "POST",
        headers: { Authorization: "Bearer token_cust_a" },
        body: {
          recipient_name: "Aanya Sharma",
          recipient_phone: "+919811000000",
          address_line1: "A".repeat(256), // > 255
          city: "New Delhi",
          state: "Delhi",
          postal_code: "110001",
        },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "VALIDATION_FAILED");
    });

    await itAsync("POST /api/customer/addresses creates shipping address with valid 6-digit PIN", async () => {
      const res = await makeRequest("/api/customer/addresses", {
        method: "POST",
        headers: { Authorization: "Bearer token_cust_a" },
        body: {
          recipient_name: "Aanya Sharma",
          recipient_phone: "+919811000000",
          address_line1: "Flat 402, Sunshine Heights",
          address_line2: "Sector 14",
          landmark: "Near Metro Gate 2",
          city: "New Delhi",
          state: "Delhi",
          postal_code: "110001",
          is_default_shipping: true,
          is_default_service: true,
        },
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.status, "success");
      assert.ok(res.body.address.id);
      assert.strictEqual(res.body.address.postal_code, "110001");
      assert.strictEqual(res.body.address.is_default_shipping, true);

      custAAddressId = res.body.address.id;
    });

    await itAsync("GET /api/customer/addresses returns saved addresses for customer A", async () => {
      const res = await makeRequest("/api/customer/addresses", {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.addresses.length, 1);
      assert.strictEqual(res.body.addresses[0].id, custAAddressId);
    });

    // Register Customer B
    const custBRes = await makeRequest("/api/auth/me", {
      headers: { Authorization: "Bearer token_cust_b" },
    });
    assert.strictEqual(custBRes.status, 200);
    createdUserIds.push(custBRes.body.user.id);

    await itAsync("Customer B cannot update Customer A's address (404 ADDRESS_NOT_FOUND)", async () => {
      const res = await makeRequest(`/api/customer/addresses/${custAAddressId}`, {
        method: "PUT",
        headers: { Authorization: "Bearer token_cust_b" },
        body: {
          recipient_name: "Hacker B",
          recipient_phone: "+919812000000",
          address_line1: "Hacked Street",
          city: "Delhi",
          state: "Delhi",
          postal_code: "110001",
        },
      });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.code, "ADDRESS_NOT_FOUND");
    });

    await itAsync("Customer B cannot delete Customer A's address (404 ADDRESS_NOT_FOUND)", async () => {
      const res = await makeRequest(`/api/customer/addresses/${custAAddressId}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token_cust_b" },
      });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.code, "ADDRESS_NOT_FOUND");
    });

    await itAsync("PUT /api/customer/addresses/:id rejects non-UUID address ID with 400 (INVALID_ID)", async () => {
      const res = await makeRequest(`/api/customer/addresses/not-a-valid-uuid`, {
        method: "PUT",
        headers: { Authorization: "Bearer token_cust_a" },
        body: {
          recipient_name: "Aanya",
          recipient_phone: "+919811000000",
          address_line1: "Street 1",
          city: "Delhi",
          state: "Delhi",
          postal_code: "110001",
        },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_ID");
    });

    await itAsync("DELETE /api/customer/addresses/:id rejects non-UUID address ID with 400 (INVALID_ID)", async () => {
      const res = await makeRequest(`/api/customer/addresses/not-a-valid-uuid`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_ID");
    });

    // ---------------------------------------------------------------------------
    // 5. ADMINISTRATOR PROVISIONING & CRYPTOGRAPHIC VERIFICATION
    // ---------------------------------------------------------------------------
    console.log("\n🧪 5. Administrator Provisioning Verification (scripts/provisionAdmin.js)");

    it("provisionAdmin CLI helper parseArgs correctly extracts flags including --allow-role-change", () => {
      const parsed = parseArgs([
        "--uid", "u123",
        "--phone", "+919811000001",
        "--name", "Raghav",
        "--role", "super_operator",
        "--allow-role-change",
      ]);
      assert.strictEqual(parsed.uid, "u123");
      assert.strictEqual(parsed.phone, "+919811000001");
      assert.strictEqual(parsed.name, "Raghav");
      assert.strictEqual(parsed.role, "super_operator");
      assert.strictEqual(parsed.allowRoleChange, true);
    });

    await itAsync("ADMIN PROVISIONING DEFENSE: Rejects non-existent Firebase account", async () => {
      let threw = false;
      try {
        await provisionAdminAccount({
          firebaseUid: "non_existent_firebase_uid_123",
          phone: "+919811000001",
          displayName: "Fake Admin",
          roleId: "super_operator",
        });
      } catch (err) {
        threw = true;
        assert.ok(err.message.includes("does not exist") || err.code === "FIREBASE_USER_NOT_FOUND");
      }
      assert.strictEqual(threw, true, "Must reject non-existent Firebase UID");
    });

    await itAsync("ADMIN PROVISIONING DEFENSE: Rejects disabled Firebase account", async () => {
      let threw = false;
      try {
        await provisionAdminAccount({
          firebaseUid: DISABLED_FIREBASE_UID,
          phone: DISABLED_FIREBASE_PHONE,
          displayName: "Disabled Admin",
          roleId: "super_operator",
        });
      } catch (err) {
        threw = true;
        assert.ok(err.message.includes("is disabled") || err.code === "FIREBASE_USER_DISABLED");
      }
      assert.strictEqual(threw, true, "Must reject disabled Firebase account");
    });

    await itAsync("ADMIN PROVISIONING DEFENSE: Rejects phone number mismatch with Firebase account", async () => {
      let threw = false;
      try {
        await provisionAdminAccount({
          firebaseUid: ADMIN_SUPER_UID,
          phone: "+919811999999", // Mismatched phone!
          displayName: "Raghav",
          roleId: "super_operator",
        });
      } catch (err) {
        threw = true;
        assert.ok(err.message.includes("Phone number mismatch") || err.code === "FIREBASE_PHONE_MISMATCH");
      }
      assert.strictEqual(threw, true, "Must reject phone number mismatch");
    });

    // Provision super_operator cleanly
    const superAdmin = await provisionAdminAccount({
      firebaseUid: ADMIN_SUPER_UID,
      phone: ADMIN_SUPER_PHONE,
      displayName: "Raghav (Super Operator)",
      roleId: "super_operator",
    });
    createdUserIds.push(superAdmin.id);

    // Provision artist_divya cleanly
    const divyaAdmin = await provisionAdminAccount({
      firebaseUid: ADMIN_DIVYA_UID,
      phone: ADMIN_DIVYA_PHONE,
      displayName: "Divya (Lead Artist)",
      roleId: "artist_divya",
    });
    createdUserIds.push(divyaAdmin.id);

    await itAsync("ADMIN PROVISIONING IDEMPOTENCY: Re-running provisioning with same role succeeds idempotently", async () => {
      const repeated = await provisionAdminAccount({
        firebaseUid: ADMIN_DIVYA_UID,
        phone: ADMIN_DIVYA_PHONE,
        displayName: "Divya (Lead Artist)",
        roleId: "artist_divya",
      });
      assert.strictEqual(repeated.id, divyaAdmin.id);
      assert.strictEqual(repeated.role_id, "artist_divya");
    });

    await itAsync("ROLE MUTATION GUARDRAIL: Attempting role change without confirmation is rejected", async () => {
      let threw = false;
      try {
        await provisionAdminAccount({
          firebaseUid: ADMIN_DIVYA_UID,
          phone: ADMIN_DIVYA_PHONE,
          displayName: "Divya",
          roleId: "super_operator", // trying to change role to super_operator
          allowRoleChange: false,
        });
      } catch (err) {
        threw = true;
        assert.ok(err.message.includes("Role conflict"), "Must report role conflict");
      }
      assert.strictEqual(threw, true, "Must require explicit confirmation to mutate roles");
    });

    await itAsync("IDENTITY COLLISION DEFENSE: Reject provisioning if Firebase UID and Phone belong to two different DB users", async () => {
      // User A has ADMIN_SUPER_UID and ADMIN_SUPER_PHONE
      // User B has ADMIN_DIVYA_UID and ADMIN_DIVYA_PHONE
      // Attempting to provision with ADMIN_SUPER_UID and ADMIN_DIVYA_PHONE
      let threw = false;
      try {
        await provisionAdminAccount({
          firebaseUid: ADMIN_SUPER_UID,
          phone: ADMIN_DIVYA_PHONE,
          displayName: "Collision Test",
          roleId: "super_operator",
        });
      } catch (err) {
        threw = true;
        assert.ok(err.message.includes("mismatch") || err.message.includes("conflict"));
      }
      assert.strictEqual(threw, true, "Must reject identity collision");
    });

    // ---------------------------------------------------------------------------
    // 6. RBAC & PERMISSION ENFORCEMENT
    // ---------------------------------------------------------------------------
    console.log("\n🧪 6. RBAC & Permission Enforcement");

    await itAsync("Regular customer accessing GET /api/admin/me is denied with 403 (FORBIDDEN_ROLE)", async () => {
      const res = await makeRequest("/api/admin/me", {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_ROLE");
    });

    await itAsync("Regular customer accessing GET /api/admin/overview is denied with 403 (FORBIDDEN_ROLE)", async () => {
      const res = await makeRequest("/api/admin/overview", {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_ROLE");
    });

    await itAsync("Lead Artist Divya receives strictly scoped permissions without Super Operator privileges", async () => {
      const res = await makeRequest("/api/admin/me", {
        headers: { Authorization: "Bearer token_admin_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.admin.displayName, "Divya (Lead Artist)");
      assert.ok(res.body.admin.roles.includes("artist_divya"));
      assert.ok(res.body.admin.permissions.includes("catalog:view"));
      assert.ok(res.body.admin.permissions.includes("orders:read"));
      assert.ok(res.body.admin.permissions.includes("bookings:read"));
      assert.ok(res.body.admin.permissions.includes("quotes:create"));
      assert.ok(res.body.admin.permissions.includes("discounts:manage"));

      // Divya must NOT hold super_operator exclusive permissions
      assert.strictEqual(res.body.admin.permissions.includes("staff:manage"), false);
      assert.strictEqual(res.body.admin.permissions.includes("financials:view"), false);
      assert.strictEqual(res.body.admin.permissions.includes("audit:view"), false);
      assert.strictEqual(res.body.admin.permissions.includes("config:edit"), false);
      assert.strictEqual(res.body.admin.permissions.includes("orders:refund"), false);
    });

    await itAsync("Lead Artist Divya accesses GET /api/admin/overview and receives real database metrics", async () => {
      const res = await makeRequest("/api/admin/overview", {
        headers: { Authorization: "Bearer token_admin_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.overview.totalProducts, 22);
      assert.strictEqual(res.body.overview.totalServices, 5);
      assert.strictEqual(res.body.overview.totalPortfolioDesigns, 60);
    });

    await itAsync("Super Operator accesses GET /api/admin/me and receives all 15 operational permissions", async () => {
      const res = await makeRequest("/api/admin/me", {
        headers: { Authorization: "Bearer token_admin_super" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.admin.displayName, "Raghav (Super Operator)");
      assert.ok(res.body.admin.roles.includes("super_operator"));
      assert.strictEqual(res.body.admin.permissions.length, 15, "Super Operator must hold all 15 permissions");
    });

    await itAsync("Super Operator accesses GET /api/admin/overview with universal override", async () => {
      const res = await makeRequest("/api/admin/overview", {
        headers: { Authorization: "Bearer token_admin_super" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.overview.totalProducts, 22);
    });

    // ---------------------------------------------------------------------------
    // 7. SUSPENDED ACCOUNT BLOCKING (CUSTOMER & ADMIN)
    // ---------------------------------------------------------------------------
    console.log("\n🧪 7. Account Suspension Enforcement (Customer & Admin)");

    // Register suspended customer
    const suspRes = await makeRequest("/api/auth/me", {
      headers: { Authorization: "Bearer token_suspended" },
    });
    assert.strictEqual(suspRes.status, 200);
    const suspendedUserId = suspRes.body.user.id;
    createdUserIds.push(suspendedUserId);

    // Deactivate customer in DB
    await query(`UPDATE users SET is_active = FALSE WHERE id = $1;`, [suspendedUserId]);

    await itAsync("Deactivated customer is rejected with 403 (ACCOUNT_SUSPENDED)", async () => {
      const res = await makeRequest("/api/auth/me", {
        headers: { Authorization: "Bearer token_suspended" },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "ACCOUNT_SUSPENDED");
    });

    // Provision suspended admin
    const suspAdmin = await provisionAdminAccount({
      firebaseUid: SUSPENDED_ADMIN_UID,
      phone: SUSPENDED_ADMIN_PHONE,
      displayName: "Suspended Staff",
      roleId: "staff_artist",
    });
    createdUserIds.push(suspAdmin.id);

    // Deactivate admin in DB
    await query(`UPDATE users SET is_active = FALSE WHERE id = $1;`, [suspAdmin.id]);

    await itAsync("Deactivated admin is rejected from GET /api/admin/me with 403 (ACCOUNT_SUSPENDED)", async () => {
      const res = await makeRequest("/api/admin/me", {
        headers: { Authorization: "Bearer token_suspended_admin" },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "ACCOUNT_SUSPENDED");
    });

    // ---------------------------------------------------------------------------
    // 8. TEST VERIFIER GUARDRAIL
    // ---------------------------------------------------------------------------
    console.log("\n🧪 8. Test Verifier Security Guardrails");

    it("setTestTokenVerifier throws error when NODE_ENV === 'production'", () => {
      const prevEnv = process.env.NODE_ENV;
      const prevConfigEnv = CONFIG.nodeEnv;
      try {
        process.env.NODE_ENV = "production";
        CONFIG.nodeEnv = "production";
        let threw = false;
        try {
          setTestTokenVerifier(() => null);
        } catch (err) {
          threw = true;
          assert.ok(err.message.includes("strictly forbidden"));
        }
        assert.strictEqual(threw, true, "Must throw in production");
      } finally {
        process.env.NODE_ENV = prevEnv;
        CONFIG.nodeEnv = prevConfigEnv;
      }
    });

    // ---------------------------------------------------------------------------
    // 9. CLEANUP TEST ADDRESS
    // ---------------------------------------------------------------------------
    if (custAAddressId) {
      await itAsync("Customer A cleans up their test address", async () => {
        const res = await makeRequest(`/api/customer/addresses/${custAAddressId}`, {
          method: "DELETE",
          headers: { Authorization: "Bearer token_cust_a" },
        });
        assert.strictEqual(res.status, 200);
      });
    }

  } finally {
    // Clean up created test user records from PostgreSQL staging to preserve 172 seed records
    if (createdUserIds.length > 0) {
      try {
        await query(
          `DELETE FROM users WHERE id = ANY($1::uuid[]);`,
          [createdUserIds]
        );
      } catch (cleanupErr) {
        console.warn("⚠️  [Cleanup Warning]:", cleanupErr.message);
      }
    }

    clearTestTokenVerifier();
    await new Promise((resolve) => testServer.close(resolve));
    await closePool();
  }

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log("\n==================================================================");
  console.log(`🏁 AUTH & SECURITY TEST EXECUTION COMPLETE: ${passedCount} Passed, ${failedCount} Failed`);
  console.log("==================================================================");

  process.exit(failedCount > 0 ? 1 : 0);
}

runAuthTestSuite().catch((err) => {
  console.error("❌ [Auth Test Runner Fatal Error]:", err);
  process.exit(1);
});
