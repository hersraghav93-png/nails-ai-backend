/**
 * ==========================================================================
 * SERVICE CATALOG PRICING & DATA INTEGRITY TEST SUITE
 * Nails by Divya Platform — Phase 4B.1
 *
 * Verifies:
 * 1. gel_extensions: basePrice 1499, promotionalPrice 999, effectivePrice 999, pricingDisplay "From ₹999"
 * 2. natural_overlay: basePrice 1299, promotionalPrice 999, effectivePrice 999, pricingDisplay "From ₹999"
 * 3. power_polish: basePrice 1199, promotionalPrice 999, effectivePrice 999, pricingDisplay "From ₹999", sanitized description without "Russian"
 * 4. custom_3d_art: basePrice null, promotionalPrice null, effectivePrice null, isCustomQuote true, pricingDisplay "Custom Quote"
 * 5. extension_removal: basePrice null, promotionalPrice null, effectivePrice null, isCustomQuote true, pricingDisplay "Custom Quote"
 * 6. Individual service endpoints (/api/services/:serviceId) preserve the exact same fields
 * 7. Active add-ons correctly mapped under parent services
 * ==========================================================================
 */

"use strict";

process.env.NODE_ENV = "test";

const http = require("http");
const assert = require("assert");
const app = require("../index");
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

let server;
let baseUrl;

function makeRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqOptions = {
      method: options.method || "GET",
      headers: options.headers || {},
    };

    const req = http.request(url, reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const body = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, body });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });

    req.on("error", reject);
    if (options.body) {
      req.setHeader("Content-Type", "application/json");
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runTests() {
  console.log("==================================================================");
  console.log("   PHASE 4B.1: SERVICE CATALOG & PRICING VERIFICATION SUITE");
  console.log("==================================================================\n");

  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`🚀 Test harness listening on ${baseUrl}\n`);
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------------------
    // 1. Direct Database Row Verification
    // -------------------------------------------------------------------------
    console.log("🧪 1. Direct PostgreSQL Services Table Verification");

    await itAsync("Database rows reflect canonical base prices and sanitized descriptions", async () => {
      const res = await query(
        `SELECT id, name, base_price, promotional_price, estimated_duration_minutes, description, is_active
         FROM services
         WHERE is_active = TRUE
         ORDER BY id ASC;`
      );

      assert.strictEqual(res.rows.length, 5);

      const byId = Object.fromEntries(res.rows.map((r) => [r.id, r]));

      // gel_extensions
      assert.strictEqual(parseFloat(byId.gel_extensions.base_price), 1499.0);
      assert.strictEqual(parseFloat(byId.gel_extensions.promotional_price), 999.0);

      // natural_overlay
      assert.strictEqual(parseFloat(byId.natural_overlay.base_price), 1299.0);
      assert.strictEqual(parseFloat(byId.natural_overlay.promotional_price), 999.0);

      // power_polish
      assert.strictEqual(parseFloat(byId.power_polish.base_price), 1199.0);
      assert.strictEqual(parseFloat(byId.power_polish.promotional_price), 999.0);
      assert.strictEqual(
        byId.power_polish.description,
        "A polished, high-gloss gel manicure service on natural nails for clients seeking long-lasting vibrant colour without tip extensions."
      );
      assert.strictEqual(byId.power_polish.description.includes("Russian"), false);

      // custom_3d_art
      assert.strictEqual(byId.custom_3d_art.base_price, null);
      assert.strictEqual(byId.custom_3d_art.promotional_price, null);

      // extension_removal
      assert.strictEqual(byId.extension_removal.base_price, null);
      assert.strictEqual(byId.extension_removal.promotional_price, null);
    });

    // -------------------------------------------------------------------------
    // 2. GET /api/services Collection Verification
    // -------------------------------------------------------------------------
    console.log("\n🧪 2. API Collection Verification (GET /api/services)");

    let services = [];

    await itAsync("GET /api/services returns 200 with all 5 canonical services", async () => {
      const res = await makeRequest("/api/services");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "success");
      assert.strictEqual(res.body.count, 5);
      assert.strictEqual(res.body.services.length, 5);
      services = res.body.services;
    });

    await itAsync("gel_extensions: basePrice 1499, promotionalPrice 999, effectivePrice 999, display 'From ₹999'", () => {
      const svc = services.find((s) => s.id === "gel_extensions");
      assert.ok(svc, "gel_extensions exists");
      assert.strictEqual(svc.basePrice, 1499);
      assert.strictEqual(svc.promotionalPrice, 999);
      assert.strictEqual(svc.effectivePrice, 999);
      assert.strictEqual(svc.isCustomQuote, false);
      assert.strictEqual(svc.pricingDisplay, "From ₹999");
      assert.strictEqual(svc.estimatedDurationMinutes, 120);
      assert.ok(svc.addons.length >= 2, "Has active add-ons");
    });

    await itAsync("natural_overlay: basePrice 1299, promotionalPrice 999, effectivePrice 999, display 'From ₹999'", () => {
      const svc = services.find((s) => s.id === "natural_overlay");
      assert.ok(svc, "natural_overlay exists");
      assert.strictEqual(svc.basePrice, 1299);
      assert.strictEqual(svc.promotionalPrice, 999);
      assert.strictEqual(svc.effectivePrice, 999);
      assert.strictEqual(svc.isCustomQuote, false);
      assert.strictEqual(svc.pricingDisplay, "From ₹999");
      assert.strictEqual(svc.estimatedDurationMinutes, 90);
      assert.ok(svc.addons.length >= 1, "Has active add-on");
    });

    await itAsync("power_polish: basePrice 1199, promotionalPrice 999, effectivePrice 999, display 'From ₹999', sanitized description", () => {
      const svc = services.find((s) => s.id === "power_polish");
      assert.ok(svc, "power_polish exists");
      assert.strictEqual(svc.basePrice, 1199);
      assert.strictEqual(svc.promotionalPrice, 999);
      assert.strictEqual(svc.effectivePrice, 999);
      assert.strictEqual(svc.isCustomQuote, false);
      assert.strictEqual(svc.pricingDisplay, "From ₹999");
      assert.strictEqual(svc.estimatedDurationMinutes, 60);
      assert.strictEqual(
        svc.description,
        "A polished, high-gloss gel manicure service on natural nails for clients seeking long-lasting vibrant colour without tip extensions."
      );
      assert.strictEqual(svc.description.includes("Russian"), false);
    });

    await itAsync("custom_3d_art: basePrice null, promotionalPrice null, effectivePrice null, display 'Custom Quote'", () => {
      const svc = services.find((s) => s.id === "custom_3d_art");
      assert.ok(svc, "custom_3d_art exists");
      assert.strictEqual(svc.basePrice, null);
      assert.strictEqual(svc.promotionalPrice, null);
      assert.strictEqual(svc.effectivePrice, null);
      assert.strictEqual(svc.isCustomQuote, true);
      assert.strictEqual(svc.pricingDisplay, "Custom Quote");
      assert.strictEqual(svc.estimatedDurationMinutes, 60);
    });

    await itAsync("extension_removal: basePrice null, promotionalPrice null, effectivePrice null, display 'Custom Quote'", () => {
      const svc = services.find((s) => s.id === "extension_removal");
      assert.ok(svc, "extension_removal exists");
      assert.strictEqual(svc.basePrice, null);
      assert.strictEqual(svc.promotionalPrice, null);
      assert.strictEqual(svc.effectivePrice, null);
      assert.strictEqual(svc.isCustomQuote, true);
      assert.strictEqual(svc.pricingDisplay, "Custom Quote");
      assert.strictEqual(svc.estimatedDurationMinutes, 45);
    });

    // -------------------------------------------------------------------------
    // 3. Individual Service Endpoints (GET /api/services/:id)
    // -------------------------------------------------------------------------
    console.log("\n🧪 3. Individual Service Endpoint Verification (GET /api/services/:id)");

    await itAsync("GET /api/services/gel_extensions returns correct basePrice and promotionalPrice", async () => {
      const res = await makeRequest("/api/services/gel_extensions");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.service.basePrice, 1499);
      assert.strictEqual(res.body.service.promotionalPrice, 999);
      assert.strictEqual(res.body.service.effectivePrice, 999);
      assert.strictEqual(res.body.service.pricingDisplay, "From ₹999");
    });

    await itAsync("GET /api/services/natural_overlay returns correct basePrice and promotionalPrice", async () => {
      const res = await makeRequest("/api/services/natural_overlay");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.service.basePrice, 1299);
      assert.strictEqual(res.body.service.promotionalPrice, 999);
      assert.strictEqual(res.body.service.effectivePrice, 999);
      assert.strictEqual(res.body.service.pricingDisplay, "From ₹999");
    });

    await itAsync("GET /api/services/power_polish returns correct basePrice, promotionalPrice and sanitized description", async () => {
      const res = await makeRequest("/api/services/power_polish");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.service.basePrice, 1199);
      assert.strictEqual(res.body.service.promotionalPrice, 999);
      assert.strictEqual(res.body.service.effectivePrice, 999);
      assert.strictEqual(res.body.service.pricingDisplay, "From ₹999");
      assert.strictEqual(
        res.body.service.description,
        "A polished, high-gloss gel manicure service on natural nails for clients seeking long-lasting vibrant colour without tip extensions."
      );
      assert.strictEqual(res.body.service.description.includes("Russian"), false);
    });

    await itAsync("GET /api/services/custom_3d_art preserves NULL pricing and Custom Quote display", async () => {
      const res = await makeRequest("/api/services/custom_3d_art");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.service.basePrice, null);
      assert.strictEqual(res.body.service.promotionalPrice, null);
      assert.strictEqual(res.body.service.effectivePrice, null);
      assert.strictEqual(res.body.service.isCustomQuote, true);
      assert.strictEqual(res.body.service.pricingDisplay, "Custom Quote");
    });

    await itAsync("GET /api/services/extension_removal preserves NULL pricing and Custom Quote display", async () => {
      const res = await makeRequest("/api/services/extension_removal");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.service.basePrice, null);
      assert.strictEqual(res.body.service.promotionalPrice, null);
      assert.strictEqual(res.body.service.effectivePrice, null);
      assert.strictEqual(res.body.service.isCustomQuote, true);
      assert.strictEqual(res.body.service.pricingDisplay, "Custom Quote");
    });

    // -------------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------------
    console.log("\n==================================================================");
    console.log(`RESULTS: ${passedCount} PASSED, ${failedCount} FAILED (TOTAL: ${passedCount + failedCount})`);
    console.log("==================================================================");

    if (failedCount > 0) {
      process.exit(1);
    } else {
      console.log("\n🎉 ALL SERVICE CATALOG TESTS PASSED CLEANLY!\n");
    }
  } finally {
    if (server) {
      server.close();
    }
    await closePool();
  }
}

runTests().catch(async (err) => {
  console.error("FATAL ERROR IN TEST SUITE:", err);
  if (server) server.close();
  await closePool();
  process.exit(1);
});
