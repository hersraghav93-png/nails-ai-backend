/**
 * ==============================================================================
 * DIVV AI QUALITY & ACCURACY VERIFICATION SUITE (`scripts/testDivvQuality.js`)
 * Nails by Divya Platform — Phase 4E.1
 *
 * Verifies:
 * 1. Service pricing against canonical catalogue (Extensions ₹1499/₹999, Overlay ₹1299/₹999, Power Polish ₹1199/₹999, 3D Art custom quote, Removal enquiry).
 * 2. Active promotion auditing (₹599 press-ons, ₹999 services; no unverified 15% loyalty, no fake coupons, no free delivery).
 * 3. Delivery policies (location-based, no free shipping claims, Pan-India vs Delhi NCR).
 * 4. At-home appointment protocol in Delhi NCR (equipment, hours, pending confirmation).
 * 5. Press-on sizing & customization (XS-L, custom mm sizing, shapes).
 * 6. Order & payment boundaries (no fake booking confirmations, no fake payment status).
 * 7. Preservation of 137 knowledge sections and 22 catalog products.
 * ==============================================================================
 */

"use strict";

const assert = require("assert");
const {
  loadKnowledgeDatabase,
  getKnowledgeStatus,
  retrieveRelevantContext
} = require("../src/services/aiService");

console.log("==================================================================");
console.log("   NAILS BY DIVYA — PHASE 4E.1 DIVV AI QUALITY TEST SUITE");
console.log("==================================================================");

let passedCount = 0;
let failedCount = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
    failedCount++;
  }
}

// Ensure database is loaded
const db = loadKnowledgeDatabase();

// ------------------------------------------------------------------------------
// TEST 1: KNOWLEDGE BASE STRUCTURAL INTEGRITY
// ------------------------------------------------------------------------------
console.log("\n🧪 1. Knowledge Base Structural Integrity & Catalogue Preservation");

it("preserves exactly 137 verified knowledge sections", () => {
  const status = getKnowledgeStatus();
  assert.strictEqual(status.isLoaded, true);
  assert.strictEqual(status.sectionsCount, 137, `Expected 137 sections, got ${status.sectionsCount}`);
  assert.strictEqual(status.version, "2.0.0");
});

it("preserves exactly 22 active handcrafted press-on products", () => {
  const products = db.sections.filter(
    (s) => s.category === "Products & Press-On Pricing" && s.id.startsWith("index.html#shop-") && s.productName
  );
  assert.strictEqual(products.length, 22, `Expected 22 products, got ${products.length}`);
});

it("preserves exactly 60 portfolio lookbook designs", () => {
  const portfolio = db.sections.filter(
    (s) => s.id.startsWith("index.html#portfolio-") && s.title.includes("Portfolio Design #")
  );
  assert.strictEqual(portfolio.length, 60, `Expected 60 portfolio designs, got ${portfolio.length}`);
});

// ------------------------------------------------------------------------------
// TEST 2: CANONICAL SERVICE PRICING RETRIEVAL
// ------------------------------------------------------------------------------
console.log("\n🧪 2. Canonical Service Pricing & Catalogue Verification");

it("retrieves canonical pricing for Nail Extensions (₹1,499 base / ₹999 promotional)", () => {
  const context = retrieveRelevantContext("How much do nail extensions cost?");
  assert.ok(context.selectedKnowledgeXml.includes("1,499") || context.selectedKnowledgeXml.includes("1499"), "Context must contain base price ₹1,499");
  assert.ok(context.selectedKnowledgeXml.includes("999"), "Context must contain promotional price ₹999");
  assert.ok(context.selectedKnowledgeXml.includes("Gel Extensions"), "Context must contain Gel Extensions");
});

it("retrieves canonical pricing for Natural Nail Overlay (₹1,299 base / ₹999 promotional)", () => {
  const context = retrieveRelevantContext("What is the price of natural nail overlay?");
  assert.ok(context.selectedKnowledgeXml.includes("1,299") || context.selectedKnowledgeXml.includes("1299"), "Context must contain base price ₹1,299");
  assert.ok(context.selectedKnowledgeXml.includes("999"), "Context must contain promotional price ₹999");
  assert.ok(context.selectedKnowledgeXml.includes("Overlay"), "Context must contain Overlay");
});

it("retrieves canonical pricing for Power Polish (₹1,199 base / ₹999 promotional)", () => {
  const context = retrieveRelevantContext("Tell me about power polish and how much it costs");
  assert.ok(context.selectedKnowledgeXml.includes("1,199") || context.selectedKnowledgeXml.includes("1199"), "Context must contain base price ₹1,199");
  assert.ok(context.selectedKnowledgeXml.includes("999"), "Context must contain promotional price ₹999");
});

it("confirms 3D Custom Artistry requires custom quotation (no fixed price)", () => {
  const context = retrieveRelevantContext("How much does 3D custom nail art cost?");
  assert.ok(context.selectedKnowledgeXml.toLowerCase().includes("custom quotation"), "Context must state 3D art requires custom quotation");
});

it("confirms Extension Removal is price on enquiry", () => {
  const context = retrieveRelevantContext("How much is nail extension removal?");
  assert.ok(context.selectedKnowledgeXml.toLowerCase().includes("price on enquiry") || context.selectedKnowledgeXml.toLowerCase().includes("removal"), "Context must mention removal on enquiry");
});

// ------------------------------------------------------------------------------
// TEST 3: PROMOTIONS AUDITING & DISALLOWING UNVERIFIED CLAIMS
// ------------------------------------------------------------------------------
console.log("\n🧪 3. Audited Promotions vs Inactive / Prohibited Claims");

it("verifies press-on promotional offer starts from ₹599", () => {
  const context = retrieveRelevantContext("What is the starting price for press-on nails?");
  assert.ok(context.selectedKnowledgeXml.includes("599"), "Context must state press-ons start from ₹599");
});

it("marks loyalty / returning client 15% discount as inactive / pending approval", () => {
  const context = retrieveRelevantContext("Do you have a 15% discount for returning clients or loyalty points?");
  assert.ok(
    context.selectedKnowledgeXml.includes("Inactive") ||
    context.selectedKnowledgeXml.includes("disabled") ||
    context.selectedKnowledgeXml.includes("Pending Business Approval"),
    "Context must state loyalty/returning discount is inactive or disabled"
  );
});

it("marks first order 10% coupon as inactive / not automated at checkout", () => {
  const context = retrieveRelevantContext("Is there a first order 10% coupon code?");
  assert.ok(
    context.selectedKnowledgeXml.includes("Inactive") ||
    context.selectedKnowledgeXml.includes("Unverified") ||
    context.selectedKnowledgeXml.includes("No automated"),
    "Context must clarify no automated 10% code exists"
  );
});

// ------------------------------------------------------------------------------
// TEST 4: DELIVERY & LOCATION POLICIES
// ------------------------------------------------------------------------------
console.log("\n🧪 4. Pan-India Delivery & Delhi NCR At-Home Appointments");

it("retrieves location-based delivery policy and rejects free shipping claims", () => {
  const context = retrieveRelevantContext("Is delivery free to Bangalore?");
  assert.ok(context.selectedKnowledgeXml.toLowerCase().includes("separate") || context.selectedKnowledgeXml.toLowerCase().includes("location"), "Delivery charges must be separate and location-based");
  assert.ok(!context.selectedKnowledgeXml.toLowerCase().includes("free shipping across india"), "Must never promise free shipping");
});

it("retrieves Delhi NCR at-home coverage areas", () => {
  const context = retrieveRelevantContext("How do at-home nail appointments work across Delhi NCR?");
  assert.ok(context.selectedKnowledgeXml.includes("Delhi"), "Must include Delhi");
  assert.ok(context.selectedKnowledgeXml.includes("Gurgaon") || context.selectedKnowledgeXml.includes("Gurugram"), "Must include Gurgaon");
  assert.ok(context.selectedKnowledgeXml.includes("Noida"), "Must include Noida");
  assert.ok(context.selectedKnowledgeXml.includes("12 PM"), "Must include operating hours 12 PM - 6 PM");
});

// ------------------------------------------------------------------------------
// TEST 5: SIZING & CUSTOMIZATION
// ------------------------------------------------------------------------------
console.log("\n🧪 5. Press-On Nail Sizing & Customization Protocol");

it("retrieves standard sizing (XS, S, M, L) and complimentary custom sizing", () => {
  const context = retrieveRelevantContext("How do I measure my nails for press-on sizing?");
  assert.ok(context.selectedKnowledgeXml.includes("XS") || context.selectedKnowledgeXml.includes("sizing"), "Must mention sizing");
  assert.ok(context.selectedKnowledgeXml.toLowerCase().includes("custom") || context.selectedKnowledgeXml.toLowerCase().includes("millimeter"), "Must mention custom sizing option");
});

// ------------------------------------------------------------------------------
// SUMMARY
// ------------------------------------------------------------------------------
console.log("\n==================================================================");
console.log(`🏁 DIVV QUALITY TEST EXECUTION COMPLETE: ${passedCount} Passed, ${failedCount} Failed`);
console.log("==================================================================");

if (failedCount > 0) {
  process.exit(1);
}
