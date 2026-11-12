#!/usr/bin/env node
"use strict";

process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const express = require("express");
const { getPool, query, withTransaction, closePool } = require("../src/db/pool");
const { setTestTokenVerifier, clearTestTokenVerifier } = require("../src/services/firebaseService");
const authRouter = require("../src/routes/authRoute");
const adminRouter = require("../src/routes/adminRoute");

async function run() {
  console.log("=== Testing POST /api/auth/verify-phone and UID Binding ===");

  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/admin", adminRouter);

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

  try {
    // Set up test token verifier hook
    const testUid = "firebase_uid_divya_real_" + Date.now();
    const testPhone = "+918447391310";

    setTestTokenVerifier(async (token) => {
      if (token === "divya_valid_token") {
        return {
          uid: testUid,
          phone_number: testPhone,
          auth_time: Math.floor(Date.now() / 1000),
        };
      }
      if (token === "unauthorized_customer_token") {
        return {
          uid: "customer_uid_" + Date.now(),
          phone_number: "+919999988888",
          auth_time: Math.floor(Date.now() / 1000),
        };
      }
      const err = new Error("Decoding Firebase ID token failed.");
      err.code = "auth/argument-error";
      throw err;
    });

    // 1. Test POST /api/auth/verify-phone without token -> 401 AUTH_REQUIRED
    console.log("1. Testing POST /api/auth/verify-phone without token...");
    const resNoToken = await request("/api/auth/verify-phone", { method: "POST" });
    assert.strictEqual(resNoToken.status, 401);
    assert.strictEqual(resNoToken.body.code, "AUTH_REQUIRED");
    console.log("  PASS: Rejected with 401 AUTH_REQUIRED");

    // 2. Test POST /api/auth/verify-phone with body { idToken: "divya_valid_token" }
    console.log("2. Testing POST /api/auth/verify-phone with body { idToken }...");
    const resWithBody = await request("/api/auth/verify-phone", {
      method: "POST",
      body: { idToken: "divya_valid_token" }
    });
    assert.strictEqual(resWithBody.status, 200);
    assert.strictEqual(resWithBody.body.status, "success");
    assert.strictEqual(resWithBody.body.user.phone, testPhone);
    assert.strictEqual(resWithBody.body.user.firebase_uid, testUid);
    assert.ok(resWithBody.body.user.roles.includes("artist_divya"), "User must have artist_divya role");
    console.log("  PASS: Verified, linked UID, returned artist_divya role");

    // 3. Test GET /api/admin/me with Divya's token -> 200 OK with artist_divya
    console.log("3. Testing GET /api/admin/me with Divya's token...");
    const resAdminMe = await request("/api/admin/me", {
      headers: { Authorization: "Bearer divya_valid_token" }
    });
    assert.strictEqual(resAdminMe.status, 200);
    assert.strictEqual(resAdminMe.body.status, "success");
    assert.strictEqual(resAdminMe.body.admin.phone, testPhone);
    assert.ok(resAdminMe.body.admin.roles.includes("artist_divya"));
    console.log("  PASS: Divya accessed /api/admin/me with artist_divya role");

    // 4. Test GET /api/admin/me with unauthorized customer token -> 403 FORBIDDEN_ROLE
    console.log("4. Testing GET /api/admin/me with unauthorized customer token...");
    const resForbidden = await request("/api/admin/me", {
      headers: { Authorization: "Bearer unauthorized_customer_token" }
    });
    assert.strictEqual(resForbidden.status, 403);
    assert.strictEqual(resForbidden.body.code, "FORBIDDEN_ROLE");
    console.log("  PASS: Unauthorized customer blocked with 403 FORBIDDEN_ROLE");

    // 5. Clean up the test UID from the database to keep staging pristine
    await query("UPDATE users SET firebase_uid = NULL WHERE phone = $1;", [testPhone]);
    console.log("5. Pristine cleanup: Reset Divya's firebase_uid back to NULL.");

    console.log("\nALL VERIFY-PHONE & ADMIN TESTS PASSED PERFECTLY!");
  } finally {
    clearTestTokenVerifier();
    server.close();
    await closePool();
  }
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
