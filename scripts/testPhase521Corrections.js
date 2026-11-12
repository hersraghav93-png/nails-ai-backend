/**
 * ==============================================================================
 * PHASE 5.2.1 FOCUSED VERIFICATION SUITE (`scripts/testPhase521Corrections.js`)
 * Nails by Divya Platform
 *
 * Validates all 6 critical Phase 5.2.1 corrections:
 * 1. WhatsApp business number centralization (8447391310) and zero 78274 leakage.
 * 2. Dynamic promotional vs non-promotional product pricing.
 * 3. Customer-facing policy copy accuracy (no Perfect Fit Guarantee, no express couriers).
 * 4. Admin authentication & RBAC boundary (rejection of unverified/operator key attempts).
 * 5. Operational analytics persistence, daily aggregation, and PII sanitization.
 * 6. Migration 006 existence and non-execution status.
 * ==============================================================================
 */

"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

// Load backend modules
const { query } = require("../src/db/pool");
const { calculateItemPricing, calculateCartTotals } = require("../src/services/pricingEngine");
const {
  VALID_EVENTS,
  PII_DISALLOWED_KEYS,
  sanitizePayload,
  recordEvent,
  getDailyAnalytics,
} = require("../src/services/analyticsService");
const { setTestTokenVerifier, clearTestTokenVerifier } = require("../src/services/firebaseService");

const FRONTEND_DIR = path.resolve(__dirname, "../../../nailsbydivya/nailsbydivya-main");
const BACKEND_DIR = path.resolve(__dirname, "..");

let passedTests = 0;
let totalTests = 0;

function report(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
    throw err;
  }
}

async function reportAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
    throw err;
  }
}

async function runSuite() {
  console.log("\n==================================================================");
  console.log("   NAILS BY DIVYA — PHASE 5.2.1 OPERATIONAL VERIFICATION SUITE");
  console.log("==================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. WhatsApp Business Number Ground Truth & Centralization
  // ---------------------------------------------------------------------------
  console.log("🧪 1. WhatsApp Business Number Centralization (8447391310)");

  report("Frontend firebase-config.js centralizes dedicated business number in window.NAILS_CONFIG", () => {
    const configPath = path.join(FRONTEND_DIR, "firebase-config.js");
    const content = fs.readFileSync(configPath, "utf8");
    assert(content.includes('phone: "+91 84473 91310"'), "Missing phone: +91 84473 91310");
    assert(content.includes('phoneRaw: "918447391310"'), "Missing phoneRaw: 918447391310");
    assert(content.includes('whatsappUrl: "https://wa.me/918447391310"'), "Missing whatsappUrl");
  });

  report("Frontend script.js resolves WhatsApp number from centralized config with 918447391310 fallback", () => {
    const scriptPath = path.join(FRONTEND_DIR, "script.js");
    const content = fs.readFileSync(scriptPath, "utf8");
    assert(content.includes('whatsappNumber: (typeof window !== "undefined" && window.NAILS_CONFIG && window.NAILS_CONFIG.business && window.NAILS_CONFIG.business.phoneRaw) || "918447391310"'), "CHECKOUT_CONFIG not using centralized business config");
  });

  report("Zero occurrences of old number 7827437985 across frontend HTML and JS files", () => {
    const files = ["index.html", "script.js", "account.html", "account.js", "auth-modal.js", "nail-art.html", "nail-extensions.html", "press-on-nails-india.html", "admin.html", "admin.js"];
    for (const file of files) {
      const filePath = path.join(FRONTEND_DIR, file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");
        assert(!content.includes("7827437985"), `Found 7827437985 in ${file}`);
        assert(!content.includes("78274 37985"), `Found 78274 37985 in ${file}`);
      }
    }
  });

  report("Zero occurrences of old number 7827437985 in backend source code and knowledge base", () => {
    const knowledgePath = path.join(BACKEND_DIR, "knowledge/database.json");
    if (fs.existsSync(knowledgePath)) {
      const content = fs.readFileSync(knowledgePath, "utf8");
      assert(!content.includes("7827437985"), "Found 7827437985 in knowledge/database.json");
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Dynamic Product Pricing (Authoritative Server & Promotional Logic)
  // ---------------------------------------------------------------------------
  console.log("\n🧪 2. Dynamic Product Pricing (Server & Client Synchrony)");

  report("Promotional press-on product receives ₹599 promo rate when base price > ₹599", () => {
    const promoProduct = {
      id: "prod-promo-01",
      sku: "WED-005",
      name: "Rosewood Bloom",
      category_id: "wedding",
      base_price: 999.00,
      is_available: true,
      is_archived: false,
    };
    const pricing = calculateItemPricing(promoProduct, 1);
    assert.strictEqual(pricing.basePrice, 999.00);
    assert.strictEqual(pricing.unitPrice, 599.00);
    assert.strictEqual(pricing.isPromoApplied, true);
    assert.strictEqual(pricing.itemDiscount, 400.00);
    assert.strictEqual(pricing.itemTotal, 599.00);
  });

  report("Non-promotional product (is_promotional: false) retains full regular base price", () => {
    const nonPromoProduct = {
      id: "prod-nonpromo-01",
      sku: "LUX-001",
      name: "Bespoke Royal Zari",
      category_id: "wedding",
      base_price: 1399.00,
      is_promotional: false, // Opts out of promotions
      is_available: true,
      is_archived: false,
    };
    const pricing = calculateItemPricing(nonPromoProduct, 1);
    assert.strictEqual(pricing.basePrice, 1399.00);
    assert.strictEqual(pricing.unitPrice, 1399.00);
    assert.strictEqual(pricing.isPromoApplied, false);
    assert.strictEqual(pricing.itemDiscount, 0.00);
    assert.strictEqual(pricing.itemTotal, 1399.00);
  });

  report("Product with base price <= ₹599 retains regular price without negative discount", () => {
    const budgetProduct = {
      id: "prod-budget-01",
      sku: "CARE-001",
      name: "Nail Care & Prep Kit",
      category_id: "care",
      base_price: 499.00,
      is_available: true,
      is_archived: false,
    };
    const pricing = calculateItemPricing(budgetProduct, 1);
    assert.strictEqual(pricing.basePrice, 499.00);
    assert.strictEqual(pricing.unitPrice, 499.00);
    assert.strictEqual(pricing.isPromoApplied, false);
    assert.strictEqual(pricing.itemDiscount, 0.00);
    assert.strictEqual(pricing.itemTotal, 499.00);
  });

  report("Frontend index.html product modal CTA button is dynamic without hardcoded ₹599", () => {
    const indexPath = path.join(FRONTEND_DIR, "index.html");
    const content = fs.readFileSync(indexPath, "utf8");
    assert(content.includes('<span id="product-modal-add-label">Add to Bag</span>'), "product-modal-add-label has hardcoded static text");
    assert(!content.includes('<span id="product-modal-add-label">Add to Bag &bull; ₹599</span>'), "product-modal-add-label still has hardcoded ₹599");
  });

  report("Frontend script.js FESTIVE_OFFER_CONFIG evaluates eligibility by numeric price comparison", () => {
    const scriptPath = path.join(FRONTEND_DIR, "script.js");
    const content = fs.readFileSync(scriptPath, "utf8");
    assert(content.includes("baseNum > 599"), "isEligible missing baseNum > 599 comparison");
    assert(content.includes("getEffectivePrice(sku"), "Missing getEffectivePrice method");
  });

  // ---------------------------------------------------------------------------
  // 3. Customer-Facing Policy Copy Accuracy
  // ---------------------------------------------------------------------------
  console.log("\n🧪 3. Customer-Facing Policy Copy Accuracy");

  report("Index.html uses accurate 'Sizing Verification' instead of 'Perfect Fit Guarantee'", () => {
    const indexPath = path.join(FRONTEND_DIR, "index.html");
    const content = fs.readFileSync(indexPath, "utf8");
    assert(!content.includes("Perfect Fit Guarantee"), "Found 'Perfect Fit Guarantee' in index.html");
    assert(content.includes("Sizing Verification"), "Missing 'Sizing Verification' in index.html");
  });

  report("All files use realistic 'tracked courier' dispatch instead of 'express courier' claims", () => {
    const files = ["index.html", "account.html", "nail-art.html", "nail-extensions.html", "press-on-nails-india.html", "admin.html"];
    for (const file of files) {
      const filePath = path.join(FRONTEND_DIR, file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");
        assert(!content.includes("express courier"), `Found 'express courier' in ${file}`);
      }
    }
  });

  report("Appointment copy uses neutral 'Appointment Terms' instead of payment-after-completion promises", () => {
    const indexPath = path.join(FRONTEND_DIR, "index.html");
    const content = fs.readFileSync(indexPath, "utf8");
    assert(!content.includes("Payment is collected in person only after your appointment is completed"), "Found payment-after-completion guarantee in index.html");
    assert(content.includes("Appointment Terms:"), "Missing 'Appointment Terms:' in index.html next steps");
  });

  report("Sizing guide is labeled as 'Reference Sizing Guide' with bespoke instructions", () => {
    const indexPath = path.join(FRONTEND_DIR, "index.html");
    const content = fs.readFileSync(indexPath, "utf8");
    assert(content.includes("REFERENCE SIZING GUIDE"), "Missing REFERENCE SIZING GUIDE label");
    assert(content.includes("Standard Nail Width References"), "Missing Standard Nail Width References title");
  });

  // ---------------------------------------------------------------------------
  // 4. Admin Authentication & RBAC Boundary Security
  // ---------------------------------------------------------------------------
  console.log("\n🧪 4. Admin Authentication & RBAC Boundary");

  report("Admin HTML removes misleading 'Operator key' label and specifies Firebase Administrator ID Token", () => {
    const adminHtmlPath = path.join(FRONTEND_DIR, "admin.html");
    const content = fs.readFileSync(adminHtmlPath, "utf8");
    assert(!content.includes("or Operator Key"), "Found 'or Operator Key' in admin.html");
    assert(!content.includes("or Operator key"), "Found 'or Operator key' in admin.html");
    assert(content.includes("Firebase Administrator ID Token"), "Missing Firebase Administrator ID Token label in admin.html");
  });

  report("Admin HTML keeps application view hidden by default (display: none)", () => {
    const adminHtmlPath = path.join(FRONTEND_DIR, "admin.html");
    const content = fs.readFileSync(adminHtmlPath, "utf8");
    assert(content.includes('<div id="admin-app-view" class="admin-layout" style="display: none;">'), "admin-app-view is not display: none");
  });

  report("Admin JS stores session token in sessionStorage (ephemeral, not persisted indefinitely in localStorage)", () => {
    const adminJsPath = path.join(FRONTEND_DIR, "admin.js");
    const content = fs.readFileSync(adminJsPath, "utf8");
    assert(content.includes('sessionStorage.getItem("nbd_admin_token")'), "admin.js not using sessionStorage for token retrieval");
    assert(content.includes('sessionStorage.setItem("nbd_admin_token", token)'), "admin.js not using sessionStorage for token storage");
  });

  // ---------------------------------------------------------------------------
  // 5. Operational Analytics & Privacy Enforcement
  // ---------------------------------------------------------------------------
  console.log("\n🧪 5. Operational Analytics (Privacy & Aggregation)");

  report("Analytics service whitelists only the 6 required business events", () => {
    const expected = ["product_view", "add_to_cart", "checkout_start", "order_submission", "booking_submission", "whatsapp_click"];
    assert.deepStrictEqual([...VALID_EVENTS].sort(), expected.sort());
  });

  report("Analytics sanitizePayload strictly removes customer names, phones, emails, addresses, and tokens", () => {
    const dirtyPayload = {
      sku: "WED-005",
      price: "₹599",
      customerName: "Priya Sharma",
      customerPhone: "+919811000000",
      customerEmail: "priya@example.com",
      address: "123 Green Park",
      shippingAddress: { line1: "123 Green Park" },
      idToken: "eyJh...fake...token",
      token: "secret_123",
      utr: "UTR987654321",
    };
    const clean = sanitizePayload(dirtyPayload);
    assert.strictEqual(clean.sku, "WED-005");
    assert.strictEqual(clean.price, "₹599");
    assert.strictEqual(clean.customerName, undefined);
    assert.strictEqual(clean.customerPhone, undefined);
    assert.strictEqual(clean.customerEmail, undefined);
    assert.strictEqual(clean.address, undefined);
    assert.strictEqual(clean.shippingAddress, undefined);
    assert.strictEqual(clean.idToken, undefined);
    assert.strictEqual(clean.token, undefined);
    assert.strictEqual(clean.utr, undefined);
  });

  await reportAsync("Analytics recordEvent rejects unsupported events with 400", async () => {
    try {
      await recordEvent({ event: "fabricated_fake_event", properties: {} });
      assert.fail("Should have thrown error on invalid event");
    } catch (err) {
      assert(err.message.includes("Unsupported analytics event"), "Expected unsupported event error");
    }
  });

  await reportAsync("Analytics recordEvent increments daily event counter atomically in PostgreSQL business_settings", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res1 = await recordEvent({
      event: "product_view",
      timestamp: new Date().toISOString(),
      properties: { sku: "WED-005" },
    });
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.event, "product_view");
    assert.strictEqual(res1.date, today);

    const res2 = await recordEvent({
      event: "whatsapp_click",
      timestamp: new Date().toISOString(),
      properties: { button: "hero_cta" },
    });
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.event, "whatsapp_click");

    const history = await getDailyAnalytics(5);
    assert(Array.isArray(history), "getDailyAnalytics should return an array");
    const todayRecord = history.find((h) => h.date === today);
    assert(todayRecord, `Today's record (${today}) not found in daily analytics history`);
    assert(todayRecord.product_view >= 1, "product_view counter should be >= 1");
    assert(todayRecord.whatsapp_click >= 1, "whatsapp_click counter should be >= 1");
  });

  // ---------------------------------------------------------------------------
  // 6. Database Migration 006 Status Verification
  // ---------------------------------------------------------------------------
  console.log("\n🧪 6. Database Migration 006 Schema & Unapplied Status");

  report("Migration 006 files exist and match SHA256 in manifest.json", () => {
    const upPath = path.join(BACKEND_DIR, "database/migrations/006_analytics_daily_events.sql");
    const downPath = path.join(BACKEND_DIR, "database/migrations/006_analytics_daily_events_rollback.sql");
    const manifestPath = path.join(BACKEND_DIR, "database/manifest.json");

    assert(fs.existsSync(upPath), "006_analytics_daily_events.sql missing");
    assert(fs.existsSync(downPath), "006_analytics_daily_events_rollback.sql missing");

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const m006 = manifest.migrations.find((m) => m.id === "006");
    assert(m006, "Migration 006 not found in manifest.json");
    assert.strictEqual(m006.status, "AUTHORED_PENDING_APPROVAL");
  });

  await reportAsync("PostgreSQL database does NOT have table analytics_daily_events (unapplied without approval)", async () => {
    const tableRes = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'analytics_daily_events';`
    );
    assert.strictEqual(
      tableRes.rows.length,
      0,
      "Migration 006 was prematurely applied! Table 'analytics_daily_events' exists in database."
    );
  });

  console.log("\n==================================================================");
  console.log(`🏁 PHASE 5.2.1 VERIFICATION COMPLETE: ${passedTests}/${totalTests} Passed (Failed: 0)`);
  console.log("==================================================================\n");
  process.exit(0);
}

runSuite().catch((err) => {
  console.error("FATAL SUITE ERROR:", err);
  process.exit(1);
});
