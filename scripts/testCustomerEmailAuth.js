#!/usr/bin/env node
/**
 * ==============================================================================
 * NAILS BY DIVYA — PHASE 2 CUSTOMER EMAIL AUTHENTICATION TEST SUITE
 * (`scripts/testCustomerEmailAuth.js`)
 *
 * Tests against isolated staging PostgreSQL:
 * 1. Magic-link registration & login (hashed token storage, Resend payload, no URL secrets)
 * 2. Firebase custom token issued ONLY after backend email verification
 * 3. Token expiry (15-min TTL) rejection & graceful error code
 * 4. Single-use token reuse prevention & concurrent replay race protection
 * 5. Anti-enumeration & per-email request throttling + rate limiting
 * 6. Admin account protection (email link cannot sign into admin roles)
 * 7. Phishing / open-redirect Origin header protection
 * 8. Unverified email claim protection in findOrCreateUserByFirebaseToken
 * 9. Historical guest order & booking association ONLY after verified email ownership
 * 10. Guest checkout (phone without SMS OTP) + authenticated checkout + logout/re-login
 * ==============================================================================
 */

"use strict";

process.env.NODE_ENV = "test";

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");
const app = require("../index");
const { query, closePool } = require("../src/db/pool");
const {
  setTestTokenVerifier,
  setTestEmailCustomTokenIssuer,
  clearTestTokenVerifier,
} = require("../src/services/firebaseService");
const {
  setTestEmailSender,
  clearTestEmailSender,
  hashLoginToken,
  resolveSafeFrontendBaseUrl,
  GENERIC_REQUEST_MESSAGE,
} = require("../src/services/emailAuthService");
const {
  findOrCreateUserByFirebaseToken,
  provisionAdminAccount,
} = require("../src/services/userService");
const { createRateLimiter } = require("../src/middleware/rateLimiter");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ [FAIL] ${name}`);
    console.error(`     ${err.stack || err.message}`);
  }
}

function makeRequest(baseUrl, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqHeaders = { "Content-Type": "application/json", ...headers };
    const payload = body ? JSON.stringify(body) : null;
    if (payload) reqHeaders["Content-Length"] = Buffer.byteLength(payload);

    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log("==================================================================");
  console.log("   PHASE 2: CUSTOMER EMAIL PASSWORDLESS AUTH TEST SUITE");
  console.log("==================================================================\n");

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const ts = Date.now();
  const guestEmail = `phase2.guest.${ts}@example.com`;
  const freshEmail = `phase2.fresh.${ts}@example.com`;
  const otherEmail = `phase2.other.${ts}@example.com`;
  const adminEmail = `phase2.admin.${ts}@nailsbydivya.store`;
  const guestPhone = `+9198${String(ts).slice(-8)}`;
  const adminPhone = `+9199${String(ts).slice(-8)}`;
  const adminUid = `fb_admin_${ts}`;

  const sentEmails = [];
  const customTokenRegistry = new Map();
  let customTokenSeq = 0;

  setTestEmailSender(async (payload) => {
    sentEmails.push(payload);
    return { id: `resend_test_${sentEmails.length}` };
  });

  setTestEmailCustomTokenIssuer(async (email, existingUid) => {
    const uid = existingUid || `fb_email_${crypto.createHash("md5").update(email).digest("hex").slice(0, 12)}`;
    const customToken = `custom_tok_${++customTokenSeq}_${uid}`;
    // Standard Firebase UserRecord.emailVerified=true propagates `email_verified: true` in ID token
    customTokenRegistry.set(customToken, { uid, email, email_verified: true });
    return { uid, emailVerified: true, customToken };
  });

  setTestTokenVerifier(async (bearerToken) => {
    if (bearerToken.startsWith("exchanged_")) {
      const customToken = bearerToken.slice("exchanged_".length);
      return customTokenRegistry.get(customToken) || null;
    }
    if (bearerToken === "unverified_email_id_token") {
      return { uid: `unverified_uid_${ts}`, email: guestEmail, email_verified: false };
    }
    if (bearerToken === "custom_claim_only_unverified") {
      // Simulates an attacker/legacy token that only has custom claim emailVerified=true without standard email_verified=true
      return { uid: `custom_only_uid_${ts}`, email: guestEmail, email_verified: false, emailVerified: true };
    }
    return null;
  });

  // Ensure product exists in local staging DB for checkout test
  const prodRes = await query(`SELECT sku FROM products WHERE is_available = TRUE AND is_archived = FALSE LIMIT 1;`);
  assert(prodRes.rows.length > 0, "Staging database must have at least 1 available product seeded");
  const testSku = prodRes.rows[0].sku;

  try {
    // 1. Pre-create a guest order and a guest booking with guestEmail (no auth token, no SMS OTP)
    let guestOrderId = null;
    let guestBookingId = null;

    await test("1. Guest checkout & guest booking work with phone number without SMS OTP", async () => {
      const cartAdd = await makeRequest(baseUrl, "POST", "/api/cart/items", {}, {
        sku: testSku,
        shape: "Almond",
        length: "Medium",
        sizing_preset: "M",
        quantity: 1,
      });
      assert.strictEqual(cartAdd.status, 201);
      const cartSession = cartAdd.headers["x-cart-session"];
      assert(cartSession, "Cart session header issued for guest");

      const orderRes = await makeRequest(
        baseUrl,
        "POST",
        "/api/orders",
        { "X-Cart-Session": cartSession },
        {
          customer: { name: "Meera Guest", phone: guestPhone, email: guestEmail },
          shipping_address: {
            recipient_name: "Meera Guest",
            phone: guestPhone,
            address_line1: "402 Lotus Towers, Golf Course Road",
            city: "Gurgaon",
            state: "Haryana",
            postal_code: "122002",
          },
          customer_notes: "Guest checkout without SMS OTP",
        }
      );
      assert.strictEqual(orderRes.status, 201);
      assert(orderRes.body.claimSecret, "Guest checkout issues claim secret");
      assert.strictEqual(orderRes.body.order.userId, null, "Guest order initially has null user_id");
      guestOrderId = orderRes.body.order.id;

      // Also place a booking request as guest with same email
      const bkgRes = await makeRequest(
        baseUrl,
        "POST",
        "/api/bookings",
        {},
        {
          customer: { name: "Meera Guest", phone: guestPhone, email: guestEmail },
          service_id: "gel_extensions",
          service_address: {
            address_line1: "402 Lotus Towers, Golf Course Road",
            city: "Gurgaon",
            state: "Haryana",
            postal_code: "122002",
          },
          requested_date: "2026-12-15",
          requested_time_slot: "Afternoon (12:00 PM - 3:00 PM)",
        }
      );
      assert.strictEqual(bkgRes.status, 201);
      guestBookingId = bkgRes.body.booking.id;
    });

    await test("2. Malformed email rejected; valid request stores ONLY hashed token and sends branded Resend email", async () => {
      const badRes = await makeRequest(baseUrl, "POST", "/api/auth/email/request-link", {}, { email: "not-an-email" });
      assert.strictEqual(badRes.status, 400);
      assert.strictEqual(badRes.body.code, "INVALID_EMAIL");

      const reqRes = await makeRequest(
        baseUrl,
        "POST",
        "/api/auth/email/request-link",
        { Origin: "https://staging.nailsbydivya.store", "User-Agent": "TestSuite/1.0" },
        { email: `  ${guestEmail.toUpperCase()}  ` }
      );
      assert.strictEqual(reqRes.status, 200);
      assert.strictEqual(reqRes.body.message, GENERIC_REQUEST_MESSAGE);
      assert.strictEqual(sentEmails.length, 1);

      const emailPayload = sentEmails[0];
      assert.strictEqual(emailPayload.to, guestEmail);
      assert(emailPayload.subject.includes("Nails by Divya"));
      assert(emailPayload.html.includes("Sign In to My Account"));

      const match = emailPayload.text.match(/https:\/\/staging\.nailsbydivya\.store\/account\.html\?email_token=([A-Za-z0-9_-]+)/);
      assert(match && match[1], "Magic link must point to allowlisted origin with only email_token query param");
      const rawToken = decodeURIComponent(match[1]);
      assert(!emailPayload.text.includes(encodeURIComponent(guestEmail)), "URL must not leak email address");

      const expectedHash = hashLoginToken(rawToken);
      const dbRes = await query(`SELECT email, token_hash, used_at FROM email_login_tokens WHERE LOWER(email) = LOWER($1);`, [guestEmail]);
      assert.strictEqual(dbRes.rows.length, 1);
      assert.strictEqual(dbRes.rows[0].token_hash, expectedHash, "Database must store SHA-256 hash");
      assert.notStrictEqual(dbRes.rows[0].token_hash, rawToken, "Raw token must NEVER be stored in DB");
      assert.strictEqual(dbRes.rows[0].used_at, null);
    });

    await test("3. Spoofed phishing Origin header is ignored when generating login link", async () => {
      assert.strictEqual(resolveSafeFrontendBaseUrl("https://evil-phishing.example"), "http://localhost:8080");
      assert.strictEqual(resolveSafeFrontendBaseUrl("https://staging.nailsbydivya.store"), "https://staging.nailsbydivya.store");
    });

    await test("4. Atomic single-use token verification prevents concurrent replay race, links guest orders & bookings, and returns custom token", async () => {
      const match = sentEmails[0].text.match(/email_token=([A-Za-z0-9_-]+)/);
      const rawToken = decodeURIComponent(match[1]);

      // Fire 2 parallel verify requests with the same valid token
      const [resA, resB] = await Promise.all([
        makeRequest(baseUrl, "POST", "/api/auth/email/verify-link", {}, { token: rawToken }),
        makeRequest(baseUrl, "POST", "/api/auth/email/verify-link", {}, { token: rawToken }),
      ]);

      const successes = [resA, resB].filter((r) => r.status === 200);
      const failures = [resA, resB].filter((r) => r.status === 401);
      assert.strictEqual(successes.length, 1, "Exactly one concurrent request can consume single-use token");
      assert.strictEqual(failures.length, 1, "Second concurrent request must fail");
      assert.strictEqual(failures[0].body.code, "TOKEN_USED");

      const ok = successes[0].body;
      assert.strictEqual(ok.status, "success");
      assert(ok.customToken, "Firebase custom token issued only after verification");
      assert.strictEqual(ok.linkedOrdersCount, 1, "1 historical guest order linked after email verification");
      assert.strictEqual(ok.linkedBookingsCount, 1, "1 historical guest booking linked after email verification");
      assert.strictEqual(ok.user.email, guestEmail);
      assert(ok.user.email_verified_at, "email_verified_at stamped");

      // Third reuse attempt also rejected with TOKEN_USED
      const resReuse = await makeRequest(baseUrl, "POST", "/api/auth/email/verify-link", {}, { token: rawToken });
      assert.strictEqual(resReuse.status, 401);
      assert.strictEqual(resReuse.body.code, "TOKEN_USED");

      // Authenticate as the customer using exchanged Firebase ID token & verify orders/bookings show up
      const idToken = `exchanged_${ok.customToken}`;
      const meRes = await makeRequest(baseUrl, "GET", "/api/auth/me", { Authorization: `Bearer ${idToken}` });
      assert.strictEqual(meRes.status, 200);
      assert.strictEqual(meRes.body.user.email, guestEmail);

      const ordersList = await makeRequest(baseUrl, "GET", "/api/orders", { Authorization: `Bearer ${idToken}` });
      assert.strictEqual(ordersList.status, 200);
      assert(ordersList.body.orders.some((o) => o.id === guestOrderId), "Customer sees linked historical guest order");

      const bookingsList = await makeRequest(baseUrl, "GET", "/api/bookings", { Authorization: `Bearer ${idToken}` });
      assert.strictEqual(bookingsList.status, 200);
      assert(bookingsList.body.bookings.some((b) => b.id === guestBookingId), "Customer sees linked historical guest booking");

      // Authenticated checkout works with phone as normal contact field without SMS OTP
      const authCart = await makeRequest(baseUrl, "POST", "/api/cart/items", { Authorization: `Bearer ${idToken}` }, {
        sku: testSku,
        shape: "Coffin",
        length: "Short",
        sizing_preset: "S",
        quantity: 1,
      });
      assert.strictEqual(authCart.status, 201);
      const authOrder = await makeRequest(
        baseUrl,
        "POST",
        "/api/orders",
        { Authorization: `Bearer ${idToken}`, "X-Cart-Session": authCart.headers["x-cart-session"] },
        {
          customer: { name: "Meera Authenticated", phone: guestPhone, email: guestEmail },
          shipping_address: {
            recipient_name: "Meera Authenticated",
            phone: guestPhone,
            address_line1: "402 Lotus Towers, Golf Course Road",
            city: "Gurgaon",
            state: "Haryana",
            postal_code: "122002",
          },
        }
      );
      assert.strictEqual(authOrder.status, 201);
      assert.strictEqual(authOrder.body.order.userId, ok.user.id);
    });

    await test("5. Logout & subsequent email sign-in resolves the SAME customer account without duplication", async () => {
      const beforeCount = sentEmails.length;
      const req2 = await makeRequest(baseUrl, "POST", "/api/auth/email/request-link", {}, { email: guestEmail });
      assert.strictEqual(req2.status, 200);
      assert.strictEqual(sentEmails.length, beforeCount + 1);

      const token2 = decodeURIComponent(sentEmails[sentEmails.length - 1].text.match(/email_token=([A-Za-z0-9_-]+)/)[1]);
      const ver2 = await makeRequest(baseUrl, "POST", "/api/auth/email/verify-link", {}, { token: token2 });
      assert.strictEqual(ver2.status, 200);

      const userRows = await query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1);`, [guestEmail]);
      assert.strictEqual(userRows.rows.length, 1, "Re-login must bind to existing user row, never duplicate");
    });

    await test("6. Expired (15+ min) and invalid links are rejected cleanly", async () => {
      // Request fresh token for otherEmail
      const reqExp = await makeRequest(baseUrl, "POST", "/api/auth/email/request-link", {}, { email: otherEmail });
      assert.strictEqual(reqExp.status, 200);
      const expToken = decodeURIComponent(sentEmails[sentEmails.length - 1].text.match(/email_token=([A-Za-z0-9_-]+)/)[1]);

      // Force token expiration past 15 minutes in DB
      await query(
        `UPDATE email_login_tokens SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE token_hash = $1;`,
        [hashLoginToken(expToken)]
      );

      const expVerify = await makeRequest(baseUrl, "POST", "/api/auth/email/verify-link", {}, { token: expToken });
      assert.strictEqual(expVerify.status, 401);
      assert.strictEqual(expVerify.body.code, "TOKEN_EXPIRED");

      // Invalid random token
      const randomToken = crypto.randomBytes(32).toString("base64url");
      const invVerify = await makeRequest(baseUrl, "POST", "/api/auth/email/verify-link", {}, { token: randomToken });
      assert.strictEqual(invVerify.status, 401);
      assert.strictEqual(invVerify.body.code, "TOKEN_INVALID");

      // Malformed short token
      const malVerify = await makeRequest(baseUrl, "POST", "/api/auth/email/verify-link", {}, { token: "abc" });
      assert.strictEqual(malVerify.status, 400);
      assert.strictEqual(malVerify.body.code, "TOKEN_INVALID");
    });

    await test("7. Anti-enumeration & per-email flood limit + admin role isolation", async () => {
      // Provision admin account with email
      const adminRec = await provisionAdminAccount({
        firebaseUid: adminUid,
        phone: adminPhone,
        displayName: "Admin Guard Test",
        roleId: "super_operator",
        devAllowUnverified: true,
      });
      await query(`UPDATE users SET email = $1 WHERE id = $2;`, [adminEmail, adminRec.id]);

      const countBeforeAdmin = sentEmails.length;
      const adminReq = await makeRequest(baseUrl, "POST", "/api/auth/email/request-link", {}, { email: adminEmail });
      assert.strictEqual(adminReq.status, 200);
      assert.strictEqual(adminReq.body.message, GENERIC_REQUEST_MESSAGE, "Anti-enumeration: identical response for admin email");
      assert.strictEqual(sentEmails.length, countBeforeAdmin, "Admin accounts must NOT be emailed customer magic links");

      // Per-email flood limit (5 max in 15 min)
      const beforeFlood = sentEmails.length;
      for (let i = 0; i < 7; i++) {
        const r = await makeRequest(baseUrl, "POST", "/api/auth/email/request-link", {}, { email: freshEmail });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.message, GENERIC_REQUEST_MESSAGE);
      }
      assert.strictEqual(sentEmails.length - beforeFlood, 5, "Per-email 15-min window strictly caps issued links at 5");
    });

    await test("8. Request/verify rate limiter returns 429 when threshold exceeded", async () => {
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "staging";
      try {
        const limiter = createRateLimiter({ windowMs: 60000, max: 2, message: "Too many" });
        let statusSet = 200;
        let nextCalls = 0;
        const fakeReq = { ip: "10.0.0.55" };
        const fakeRes = {
          setHeader: () => {},
          status: (s) => {
            statusSet = s;
            return { json: () => {} };
          },
        };
        limiter(fakeReq, fakeRes, () => nextCalls++);
        limiter(fakeReq, fakeRes, () => nextCalls++);
        limiter(fakeReq, fakeRes, () => nextCalls++);
        assert.strictEqual(nextCalls, 2);
        assert.strictEqual(statusSet, 429);
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    await test("9. Unverified email claim (including spoofed emailVerified custom claim) is rejected from binding accounts", async () => {
      const userObj = await findOrCreateUserByFirebaseToken({
        uid: `unverified_uid_${ts}`,
        email: guestEmail,
        email_verified: false,
      });
      assert.strictEqual(userObj.email, null, "Unverified email claim must NOT link or bind existing email account");

      const spoofedCustomObj = await findOrCreateUserByFirebaseToken({
        uid: `custom_only_uid_${ts}`,
        email: guestEmail,
        email_verified: false,
        emailVerified: true,
      });
      assert.strictEqual(spoofedCustomObj.email, null, "Custom claim emailVerified=true without standard email_verified=true must NOT link account");
    });
  } finally {
    // Clean up test rows in local staging DB only
    await query(`DELETE FROM email_login_tokens WHERE LOWER(email) IN ($1, $2, $3, $4);`, [
      guestEmail,
      freshEmail,
      otherEmail,
      adminEmail,
    ]).catch(() => {});
    await query(`DELETE FROM orders WHERE LOWER(customer_email) IN ($1, $2);`, [guestEmail, otherEmail]).catch(() => {});
    await query(`DELETE FROM bookings WHERE LOWER(customer_email) IN ($1, $2);`, [guestEmail, otherEmail]).catch(() => {});
    await query(`DELETE FROM users WHERE LOWER(email) IN ($1, $2, $3) OR firebase_uid IN ($4, $5, $6);`, [
      guestEmail,
      freshEmail,
      adminEmail,
      adminUid,
      `unverified_uid_${ts}`,
      `custom_only_uid_${ts}`,
    ]).catch(() => {});

    clearTestTokenVerifier();
    clearTestEmailSender();
    server.close();
    await closePool();
  }

  console.log("\n==================================================================");
  console.log(`PHASE 2 EMAIL AUTH RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================================");
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("FATAL TEST ERROR:", err);
  process.exit(1);
});
