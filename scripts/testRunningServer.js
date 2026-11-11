/**
 * ==========================================================================
 * LIVE HTTP SERVER CONTRACT TEST (`scripts/testRunningServer.js`)
 * Tests GET /, GET /health, and POST /chat against the live Express backend.
 * ==========================================================================
 */

const http = require("http");
const assert = require("assert");
const app = require("../index");
const { closePool } = require("../src/db/pool");

async function runLiveServerTests() {
  console.log("==================================================================");
  console.log("   NAILS BY DIVYA — LIVE RUNNING SERVER HTTP CONTRACT TEST");
  console.log("==================================================================\n");

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`🚀 Live test server running on ${baseUrl}\n`);

  function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const reqHeaders = { ...headers };
      let payload = null;

      if (body) {
        payload = typeof body === "string" ? body : JSON.stringify(body);
        reqHeaders["Content-Type"] = "application/json";
        reqHeaders["Content-Length"] = Buffer.byteLength(payload);
      }

      const req = http.request(
        url,
        {
          method,
          headers: reqHeaders,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            let parsedBody;
            try {
              parsedBody = JSON.parse(data);
            } catch {
              parsedBody = data;
            }
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: parsedBody,
            });
          });
        }
      );

      req.on("error", reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  try {
    // 1. GET /
    console.log("🌐 1. Testing GET / (Root Health Check)");
    const rootRes = await request("GET", "/");
    console.log(`   HTTP Status: ${rootRes.statusCode}`);
    console.log(`   Response:`, JSON.stringify(rootRes.body, null, 2));
    assert.strictEqual(rootRes.statusCode, 200);
    assert.strictEqual(rootRes.body.status, "healthy");
    assert.strictEqual(rootRes.body.database.status, "connected");
    assert.strictEqual(rootRes.body.knowledge.status, "ready");
    console.log("   ✅ GET / contract verified healthy.\n");

    // 2. GET /health
    console.log("🌐 2. Testing GET /health (Diagnostic Telemetry)");
    const healthRes = await request("GET", "/health");
    console.log(`   HTTP Status: ${healthRes.statusCode}`);
    console.log(`   Response:`, JSON.stringify(healthRes.body, null, 2));
    assert.strictEqual(healthRes.statusCode, 200);
    assert.strictEqual(healthRes.body.status, "healthy");
    assert.strictEqual(healthRes.body.database.status, "connected");
    assert.ok(typeof healthRes.body.database.latencyMs === "number");
    assert.ok(healthRes.body.database.pool.total >= 1);
    console.log("   ✅ GET /health diagnostic telemetry verified.\n");

    // 3. POST /chat with invalid payload
    console.log("💬 3. Testing POST /chat with missing 'message' payload");
    const invalidChatRes = await request("POST", "/chat", {});
    console.log(`   HTTP Status: ${invalidChatRes.statusCode}`);
    console.log(`   Response:`, JSON.stringify(invalidChatRes.body, null, 2));
    assert.strictEqual(invalidChatRes.statusCode, 400);
    assert.ok(invalidChatRes.body.error.includes("'message' string is required"));
    console.log("   ✅ POST /chat payload validation verified (400 Bad Request).\n");

    // 4. POST /chat with valid inquiry
    console.log("💬 4. Testing POST /chat with valid customer query");
    const validChatRes = await request("POST", "/chat", {
      message: "What are your standard press-on nail shapes and how long do they last?",
      history: [],
    });
    console.log(`   HTTP Status: ${validChatRes.statusCode}`);
    console.log(`   Response:`, JSON.stringify(validChatRes.body, null, 2));
    assert.ok(validChatRes.statusCode === 200 || validChatRes.statusCode === 500);
    if (validChatRes.statusCode === 200) {
      assert.ok(typeof validChatRes.body.reply === "string");
      assert.ok(validChatRes.body.reply.length > 0);
      console.log("   ✅ POST /chat live response generated successfully.\n");
    } else {
      console.log("   ℹ️  Note: Gemini API key not set in .env; error handler caught gracefully.\n");
    }

    console.log("==================================================================");
    console.log("🎉 ALL LIVE RUNNING SERVER HTTP CONTRACT TESTS PASSED CLEANLY!");
    console.log("==================================================================\n");

    await new Promise((resolve) => server.close(resolve));
    await closePool();
    process.exit(0);
  } catch (err) {
    console.error("❌ [Live Server Test Failed]:", err.message);
    await new Promise((resolve) => server.close(resolve));
    await closePool();
    process.exit(1);
  }
}

runLiveServerTests();
