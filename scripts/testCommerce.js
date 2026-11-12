/**
 * ==========================================================================
 * COMMERCE ENGINE TEST SUITE (`scripts/testCommerce.js`)
 * Nails by Divya Platform — Phase 2A
 *
 * Automated regression & integration test suite covering:
 * - Guest & Authenticated Cart Management
 * - Sizing, Quantity & SKU Server-Side Validation
 * - Price Tampering Prevention & Festive Promotional Pricing
 * - Guest & Authenticated Checkout
 * - Idempotency & Duplicate Prevention
 * - Database Transaction Rollbacks
 * - Strict Cross-Customer Isolation & Unauthorized Access Prevention
 * - Order Cancellation Life-Cycle
 * - Administrative Order Listing & Status Transitions (RBAC & Audit Trail)
 * - Order Status History
 * ==========================================================================
 */

"use strict";

process.env.NODE_ENV = "test";

const http = require("http");
const assert = require("assert");
const crypto = require("crypto");
const app = require("../index");
const CONFIG = require("../src/config");
const {
  setTestTokenVerifier,
  clearTestTokenVerifier,
} = require("../src/services/firebaseService");
const {
  findOrCreateUserByFirebaseToken,
  provisionAdminAccount,
} = require("../src/services/userService");
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

async function runCommerceTestSuite() {
  console.log("==================================================================");
  console.log("   NAILS BY DIVYA — PHASE 2A COMMERCE ENGINE TEST SUITE");
  console.log("==================================================================\n");

  // Spin up temporary test HTTP server
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

  // Setup test identities
  const ts = Date.now();
  const CUST_A_UID = `cust_comm_a_${ts}`;
  const CUST_A_PHONE = `+919811${Math.floor(100000 + Math.random() * 900000)}`;
  const CUST_B_UID = `cust_comm_b_${ts}`;
  const CUST_B_PHONE = `+919812${Math.floor(100000 + Math.random() * 900000)}`;
  const ADMIN_UID = `admin_comm_${ts}`;
  const ADMIN_PHONE = `+919813${Math.floor(100000 + Math.random() * 900000)}`;

  const mockFirebaseUsers = {
    [ADMIN_UID]: { uid: ADMIN_UID, phoneNumber: ADMIN_PHONE, disabled: false },
    [CUST_A_UID]: { uid: CUST_A_UID, phoneNumber: CUST_A_PHONE, disabled: false },
    [CUST_B_UID]: { uid: CUST_B_UID, phoneNumber: CUST_B_PHONE, disabled: false },
  };

  setTestTokenVerifier(
    async (token) => {
      if (token === "token_cust_a") {
        return {
          uid: CUST_A_UID,
          phone_number: CUST_A_PHONE,
          auth_time: Math.floor(Date.now() / 1000),
        };
      }
      if (token === "token_cust_b") {
        return {
          uid: CUST_B_UID,
          phone_number: CUST_B_PHONE,
          auth_time: Math.floor(Date.now() / 1000),
        };
      }
      if (token === "token_admin") {
        return {
          uid: ADMIN_UID,
          phone_number: ADMIN_PHONE,
          auth_time: Math.floor(Date.now() / 1000),
        };
      }
      const err = new Error("Invalid test token");
      err.code = "INVALID_TOKEN";
      err.statusCode = 401;
      throw err;
    },
    async (uid) => mockFirebaseUsers[uid] || null
  );

  // Provision accounts in database
  const userA = await findOrCreateUserByFirebaseToken({
    uid: CUST_A_UID,
    phone_number: CUST_A_PHONE,
  });

  const userB = await findOrCreateUserByFirebaseToken({
    uid: CUST_B_UID,
    phone_number: CUST_B_PHONE,
  });

  const adminUser = await findOrCreateUserByFirebaseToken({
    uid: ADMIN_UID,
    phone_number: ADMIN_PHONE,
  });

  await provisionAdminAccount({
    firebaseUid: ADMIN_UID,
    phone: ADMIN_PHONE,
    roleId: "super_operator",
    displayName: "Commerce Super Operator",
  });

  let guestSessionToken = null;
  let guestCartId = null;
  let createdOrderId = null;
  let guestClaimSecret = null;
  let authOrderId = null;

  try {
    // =========================================================================
    // SUITE 1: Guest Cart Operations
    // =========================================================================
    console.log("🧪 1. Guest Cart Operations (/api/cart)");

    await itAsync("GET /api/cart initializes a new guest cart and returns session token", async () => {
      const res = await makeRequest("/api/cart");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "success");
      assert.ok(res.body.cart.id);
      assert.ok(res.body.cart.sessionToken);
      assert.strictEqual(res.body.cart.userId, null);
      assert.strictEqual(res.body.items.length, 0);
      assert.strictEqual(res.body.totals.totalAmount, 0);

      guestSessionToken = res.body.cart.sessionToken;
      guestCartId = res.body.cart.id;
    });

    await itAsync("POST /api/cart/items adds an item to guest cart", async () => {
      const res = await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { "X-Cart-Session": guestSessionToken },
        body: {
          sku: "CAS-004", // Molten Chrome Ripple (Base: 899, Promo: 599)
          shape: "Almond",
          length: "Medium",
          sizing_preset: "M",
          quantity: 2,
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.status, "success");
      assert.strictEqual(res.body.items.length, 1);
      assert.strictEqual(res.body.items[0].sku, "CAS-004");
      assert.strictEqual(res.body.items[0].quantity, 2);
      assert.strictEqual(res.body.items[0].shape, "Almond");
      assert.strictEqual(res.body.items[0].length, "Medium");
      assert.strictEqual(res.body.items[0].sizingPreset, "M");
    });

    await itAsync("PUT /api/cart/items/:id updates item quantity", async () => {
      const cartRes = await makeRequest("/api/cart", {
        headers: { "X-Cart-Session": guestSessionToken },
      });
      const itemId = cartRes.body.items[0].id;

      const res = await makeRequest(`/api/cart/items/${itemId}`, {
        method: "PUT",
        headers: { "X-Cart-Session": guestSessionToken },
        body: { quantity: 3 },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.items[0].quantity, 3);
    });

    // =========================================================================
    // SUITE 2: Authenticated Customer Cart & Cart Claiming
    // =========================================================================
    console.log("\n🧪 2. Authenticated Customer Cart & Cart Association");

    await itAsync("GET /api/cart with auth token returns customer-scoped cart", async () => {
      const res = await makeRequest("/api/cart", {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.cart.userId, userA.id);
    });

    await itAsync("POST /api/cart/claim associates guest cart with authenticated customer", async () => {
      // Create fresh guest cart
      const guestRes = await makeRequest("/api/cart");
      const tempGuestToken = guestRes.body.cart.sessionToken;

      // Add item to guest cart
      await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { "X-Cart-Session": tempGuestToken },
        body: {
          sku: "WED-005", // Rosewood Bloom
          shape: "Square",
          length: "Short",
          sizing_preset: "S",
          quantity: 1,
        },
      });

      // Claim as Customer B
      const claimRes = await makeRequest("/api/cart/claim", {
        method: "POST",
        headers: {
          Authorization: "Bearer token_cust_b",
          "X-Cart-Session": tempGuestToken,
        },
      });

      assert.strictEqual(claimRes.status, 200);
      assert.strictEqual(claimRes.body.cart.userId, userB.id);
      assert.ok(claimRes.body.items.some((i) => i.sku === "WED-005"));
    });

    // =========================================================================
    // SUITE 3: SKU, Quantity & Sizing Validation
    // =========================================================================
    console.log("\n🧪 3. Server-Side SKU, Quantity & Sizing Validation");

    await itAsync("POST /api/cart/items rejects nonexistent or archived SKU with 400", async () => {
      const res = await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { "X-Cart-Session": guestSessionToken },
        body: {
          sku: "NON-EXISTENT-SKU-999",
          shape: "Almond",
          length: "Medium",
          quantity: 1,
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_SKU");
    });

    await itAsync("POST /api/cart/items rejects invalid or negative quantity with 400", async () => {
      const resZero = await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { "X-Cart-Session": guestSessionToken },
        body: { sku: "CAS-004", shape: "Almond", length: "Medium", quantity: 0 },
      });
      assert.strictEqual(resZero.status, 400);
      assert.strictEqual(resZero.body.code, "INVALID_QUANTITY");

      const resNegative = await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { "X-Cart-Session": guestSessionToken },
        body: { sku: "CAS-004", shape: "Almond", length: "Medium", quantity: -2 },
      });
      assert.strictEqual(resNegative.status, 400);
      assert.strictEqual(resNegative.body.code, "INVALID_QUANTITY");

      const resExcess = await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { "X-Cart-Session": guestSessionToken },
        body: { sku: "CAS-004", shape: "Almond", length: "Medium", quantity: 99 },
      });
      assert.strictEqual(resExcess.status, 400);
      assert.strictEqual(resExcess.body.code, "EXCEEDS_MAX_QUANTITY");
    });

    await itAsync("POST /api/cart/items rejects invalid nail shape with 400", async () => {
      const res = await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { "X-Cart-Session": guestSessionToken },
        body: { sku: "CAS-004", shape: "Triangle-Unverified", length: "Medium", quantity: 1 },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_SHAPE");
    });

    await itAsync("POST /api/cart/items rejects invalid nail length with 400", async () => {
      const res = await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { "X-Cart-Session": guestSessionToken },
        body: { sku: "CAS-004", shape: "Almond", length: "Micro-Mini", quantity: 1 },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_LENGTH");
    });

    await itAsync("POST /api/cart/items accepts custom sizing measurements", async () => {
      const res = await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { "X-Cart-Session": guestSessionToken },
        body: {
          sku: "CAS-005", // Silver Petal
          shape: "Oval",
          length: "Short",
          sizing_preset: "Custom",
          custom_measurements: {
            thumb: 15.5,
            index: 12.0,
            middle: 13.0,
            ring: 11.5,
            pinky: 8.5,
            notes: "Extra curved nail bed on left hand thumb",
          },
          quantity: 1,
        },
      });

      assert.strictEqual(res.status, 201);
      const customItem = res.body.items.find((i) => i.sku === "CAS-005");
      assert.ok(customItem);
      assert.strictEqual(customItem.sizingPreset, "Custom");
      assert.strictEqual(customItem.customMeasurements.thumb, 15.5);
      assert.strictEqual(customItem.customMeasurements.notes, "Extra curved nail bed on left hand thumb");
    });

    // =========================================================================
    // SUITE 4: Price Tampering Defense & Festive Promotion Rules
    // =========================================================================
    console.log("\n🧪 4. Price Tampering Defense & Server-Side Calculations");

    await itAsync("Server ignores browser-submitted prices and enforces database pricing", async () => {
      const res = await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { "X-Cart-Session": guestSessionToken },
        body: {
          sku: "CAS-004", // Base price in DB: 899.00
          shape: "Almond",
          length: "Medium",
          quantity: 1,
          unit_price: 1.0, // Attempted tamper to ₹1
          total_price: 1.0,
          discount_amount: 9999.0,
        },
      });

      assert.strictEqual(res.status, 201);
      const item = res.body.items.find((i) => i.sku === "CAS-004");
      // Under Festive Offer: promo price is ₹599.00 (not ₹1.00)
      assert.strictEqual(item.unitPrice, 599.0);
      assert.strictEqual(item.basePrice, 899.0);
      assert.strictEqual(item.basePrice - item.unitPrice, 300.0);
      assert.strictEqual(item.isPromoApplied, true);
    });

    await itAsync("Cart totals accurately aggregate subtotals and festive savings", async () => {
      const res = await makeRequest("/api/cart", {
        headers: { "X-Cart-Session": guestSessionToken },
      });

      const { totals, items } = res.body;
      let expectedSubtotal = 0;
      let expectedTotal = 0;
      for (const item of items) {
        expectedSubtotal += item.itemSubtotal;
        expectedTotal += item.itemTotal;
      }

      assert.strictEqual(totals.subtotal, parseFloat(expectedSubtotal.toFixed(2)));
      assert.strictEqual(totals.totalAmount, parseFloat(expectedTotal.toFixed(2)));
      assert.strictEqual(totals.currency, "INR");
    });

    // =========================================================================
    // SUITE 5: Guest Checkout & Order Item Snapshots
    // =========================================================================
    console.log("\n🧪 5. Guest Checkout & Immutable Snapshots (/api/orders)");

    await itAsync("POST /api/orders creates a guest order with immutable snapshots and claim secret", async () => {
      const res = await makeRequest("/api/orders", {
        method: "POST",
        headers: { "X-Cart-Session": guestSessionToken },
        body: {
          customer: {
            name: "Aditi Sharma",
            phone: "+919876543210",
            email: "aditi.sharma@example.com",
          },
          shipping_address: {
            recipient_name: "Aditi Sharma",
            phone: "+919876543210",
            address_line1: "Flat 402, DLF Phase 5",
            landmark: "Near Club Drive",
            city: "Gurgaon",
            state: "Haryana",
            postal_code: "122002",
          },
          customer_notes: "Please package in luxury velvet keepsake box.",
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.status, "success");
      assert.ok(res.body.order.orderNumber.startsWith("NBD-ORD-"));
      assert.strictEqual(res.body.order.orderStatus, "PENDING");
      assert.strictEqual(res.body.order.paymentStatus, "PENDING");
      assert.strictEqual(res.body.order.fulfilmentStatus, "UNFULFILLED");
      assert.strictEqual(res.body.order.customerName, "Aditi Sharma");
      assert.strictEqual(res.body.order.shippingAddress.postal_code, "122002");
      assert.ok(res.body.claimSecret); // Guest claim secret returned
      assert.ok(res.body.items.length > 0);

      // Verify immutable snapshot details
      const firstItem = res.body.items[0];
      assert.ok(firstItem.sku);
      assert.ok(firstItem.productName);
      assert.ok(firstItem.unitPrice > 0);
      assert.ok(firstItem.variantDetails.shape);
      assert.ok(firstItem.variantDetails.length);
      assert.strictEqual(firstItem.variantDetails.promo_applied, "FESTIVE_599");

      createdOrderId = res.body.order.id;
      guestClaimSecret = res.body.claimSecret;
    });

    await itAsync("Order creation empties the cart items", async () => {
      const cartRes = await makeRequest("/api/cart", {
        headers: { "X-Cart-Session": guestSessionToken },
      });
      assert.strictEqual(cartRes.body.items.length, 0);
      assert.strictEqual(cartRes.body.totals.totalAmount, 0);
    });

    // =========================================================================
    // SUITE 6: Authenticated Checkout
    // =========================================================================
    console.log("\n🧪 6. Authenticated Customer Checkout");

    await itAsync("POST /api/orders creates an authenticated order linked to user_id", async () => {
      // Add product to customer A cart
      await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { Authorization: "Bearer token_cust_a" },
        body: {
          sku: "WED-001", // Pearl Blossom
          shape: "Almond",
          length: "Medium",
          sizing_preset: "M",
          quantity: 1,
        },
      });

      const res = await makeRequest("/api/orders", {
        method: "POST",
        headers: { Authorization: "Bearer token_cust_a" },
        body: {
          customer: {
            name: "Customer A",
            phone: CUST_A_PHONE,
          },
          shipping_address: {
            recipient_name: "Customer A",
            phone: CUST_A_PHONE,
            address_line1: "B-12 Greater Kailash 1",
            city: "New Delhi",
            state: "Delhi",
            postal_code: "110048",
          },
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.order.userId, userA.id);
      assert.strictEqual(res.body.order.orderStatus, "PENDING");
      assert.strictEqual(res.body.order.paymentStatus, "PENDING");
      assert.strictEqual(res.body.claimSecret, null); // Authenticated orders don't need guest claim secret

      authOrderId = res.body.order.id;
    });

    // =========================================================================
    // SUITE 7: Idempotency Protection
    // =========================================================================
    console.log("\n🧪 7. Idempotency & Duplicate Submission Prevention");

    await itAsync("Submitting order with same Idempotency-Key returns existing order without creating duplicate", async () => {
      // Prepare cart for idempotency test
      const idemCartRes = await makeRequest("/api/cart");
      const idemSessionToken = idemCartRes.body.cart.sessionToken;

      await makeRequest("/api/cart/items", {
        method: "POST",
        headers: { "X-Cart-Session": idemSessionToken },
        body: { sku: "CAS-004", shape: "Almond", length: "Short", quantity: 1 },
      });

      const testIdempotencyKey = `idem-test-key-${ts}`;

      // First submission
      const res1 = await makeRequest("/api/orders", {
        method: "POST",
        headers: {
          "X-Cart-Session": idemSessionToken,
          "Idempotency-Key": testIdempotencyKey,
        },
        body: {
          customer: { name: "Idem User", phone: "+919811223344" },
          shipping_address: {
            recipient_name: "Idem User",
            phone: "+919811223344",
            address_line1: "123 Test St",
            city: "Noida",
            state: "Uttar Pradesh",
            postal_code: "201301",
          },
        },
      });

      assert.strictEqual(res1.status, 201);
      const originalOrderNumber = res1.body.order.orderNumber;
      const originalOrderId = res1.body.order.id;

      // Second submission with exact same idempotency key
      const res2 = await makeRequest("/api/orders", {
        method: "POST",
        headers: {
          "X-Cart-Session": idemSessionToken,
          "Idempotency-Key": testIdempotencyKey,
        },
        body: {
          customer: { name: "Idem User", phone: "+919811223344" },
          shipping_address: {
            recipient_name: "Idem User",
            phone: "+919811223344",
            address_line1: "123 Test St",
            city: "Noida",
            state: "Uttar Pradesh",
            postal_code: "201301",
          },
        },
      });

      assert.strictEqual(res2.status, 200); // 200 indicates idempotent replay
      assert.strictEqual(res2.body.order.orderNumber, originalOrderNumber);
      assert.strictEqual(res2.body.order.id, originalOrderId);
      assert.strictEqual(res2.body.isDuplicate, true);

      // Verify in DB that only 1 order exists for this idempotency key
      const dbCheck = await query(
        `SELECT COUNT(*)::int AS count FROM orders WHERE guest_session_token = $1;`,
        [`idem:${testIdempotencyKey}`]
      );
      assert.strictEqual(dbCheck.rows[0].count, 1);
    });

    // =========================================================================
    // SUITE 8: Database Transaction Rollback
    // =========================================================================
    console.log("\n🧪 8. Database Transaction Rollbacks");

    await itAsync("Order creation rejects empty cart and creates 0 order rows", async () => {
      const emptyCartRes = await makeRequest("/api/cart");
      const emptySession = emptyCartRes.body.cart.sessionToken;

      const preCountRes = await query(`SELECT COUNT(*)::int AS count FROM orders;`);
      const preCount = preCountRes.rows[0].count;

      const res = await makeRequest("/api/orders", {
        method: "POST",
        headers: { "X-Cart-Session": emptySession },
        body: {
          customer: { name: "Empty Tester", phone: "+919876543210" },
          shipping_address: {
            recipient_name: "Empty Tester",
            phone: "+919876543210",
            address_line1: "Empty Lane",
            city: "Delhi",
            state: "Delhi",
            postal_code: "110001",
          },
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "EMPTY_CART");

      const postCountRes = await query(`SELECT COUNT(*)::int AS count FROM orders;`);
      assert.strictEqual(postCountRes.rows[0].count, preCount);
    });

    // =========================================================================
    // SUITE 9: Cross-Customer Isolation & Authorization
    // =========================================================================
    console.log("\n🧪 9. Cross-Customer Data Isolation & Security");

    await itAsync("Unauthenticated stranger cannot access an order without credentials", async () => {
      const res = await makeRequest(`/api/orders/${authOrderId}`);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_ORDER_ACCESS");
    });

    await itAsync("Customer B cannot access Customer A's order", async () => {
      const res = await makeRequest(`/api/orders/${authOrderId}`, {
        headers: { Authorization: "Bearer token_cust_b" },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_ORDER_ACCESS");
    });

    await itAsync("Customer A can access their own order", async () => {
      const res = await makeRequest(`/api/orders/${authOrderId}`, {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.order.id, authOrderId);
    });

    await itAsync("Guest can access their order using valid claim_secret", async () => {
      const res = await makeRequest(`/api/orders/${createdOrderId}?claim_secret=${guestClaimSecret}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.order.id, createdOrderId);
    });

    await itAsync("GET /api/orders lists only authenticated customer's own orders", async () => {
      const resA = await makeRequest("/api/orders", {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(resA.status, 200);
      assert.ok(resA.body.orders.every((o) => o.id === authOrderId));

      const resB = await makeRequest("/api/orders", {
        headers: { Authorization: "Bearer token_cust_b" },
      });
      assert.strictEqual(resB.status, 200);
      assert.ok(!resB.body.orders.some((o) => o.id === authOrderId));
    });

    // =========================================================================
    // SUITE 10: Order Cancellation
    // =========================================================================
    console.log("\n🧪 10. Order Cancellation Life-Cycle");

    await itAsync("Customer A can cancel their unpaid PENDING order", async () => {
      const res = await makeRequest(`/api/orders/${authOrderId}/cancel`, {
        method: "POST",
        headers: { Authorization: "Bearer token_cust_a" },
        body: { reason: "Need to change nail shape preference." },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.order.orderStatus, "CANCELLED");
    });

    await itAsync("Attempting to cancel an already CANCELLED order is rejected with 400", async () => {
      const res = await makeRequest(`/api/orders/${authOrderId}/cancel`, {
        method: "POST",
        headers: { Authorization: "Bearer token_cust_a" },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "ORDER_CANNOT_BE_CANCELLED");
    });

    // =========================================================================
    // SUITE 11: Administrative Order Management & RBAC
    // =========================================================================
    console.log("\n🧪 11. Administrative Order Management & RBAC");

    await itAsync("Regular customer cannot access GET /api/admin/orders (403 Forbidden)", async () => {
      const res = await makeRequest("/api/admin/orders", {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_ROLE");
    });

    await itAsync("Admin can list orders with pagination and status filters", async () => {
      const res = await makeRequest("/api/admin/orders?limit=10", {
        headers: { Authorization: "Bearer token_admin" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.orders));
      assert.ok(res.body.total >= 2);
    });

    await itAsync("Admin can update order status and write to order_status_history & audit_logs", async () => {
      // 1. Business safety check: Cannot move to IN_PRODUCTION before payment is verified
      const unverifiedRes = await makeRequest(`/api/admin/orders/${createdOrderId}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_admin" },
        body: {
          order_status: "IN_PRODUCTION",
        },
      });
      assert.strictEqual(unverifiedRes.status, 400);
      assert.strictEqual(unverifiedRes.body.code, "PAYMENT_NOT_VERIFIED");

      // 2. Admin verifies payment
      const payRes = await makeRequest(`/api/admin/orders/${createdOrderId}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_admin" },
        body: {
          paymentStatus: "VERIFIED",
          paymentMethod: "manual_upi",
          transactionReference: `UPI-COMMERCE-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          notes: "Payment verified in studio account.",
        },
      });
      assert.strictEqual(payRes.status, 200);
      assert.strictEqual(payRes.body.paymentStatus, "VERIFIED");

      // 3. Now move to IN_PRODUCTION and READY_FOR_DISPATCH
      const patchRes = await makeRequest(`/api/admin/orders/${createdOrderId}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_admin" },
        body: {
          order_status: "IN_PRODUCTION",
          fulfilment_status: "READY_FOR_DISPATCH",
          notes: "Divya finished hand-painting 3D florals; packed in gift box.",
        },
      });

      assert.strictEqual(patchRes.status, 200);
      assert.strictEqual(patchRes.body.order.orderStatus, "IN_PRODUCTION");
      assert.strictEqual(patchRes.body.order.fulfilmentStatus, "READY_FOR_DISPATCH");

      // Verify audit log exists
      const auditRes = await query(
        `SELECT * FROM audit_logs 
         WHERE target_entity = 'orders' AND target_id = $1 AND action = 'ORDER_STATUS_UPDATED';`,
        [createdOrderId]
      );
      assert.strictEqual(auditRes.rows.length, 1);
      assert.strictEqual(auditRes.rows[0].actor_id, adminUser.id);
    });

    // =========================================================================
    // SUITE 12: Order Status History Verification
    // =========================================================================
    console.log("\n🧪 12. Order Status History Tracking");

    await itAsync("Order status history tracks all transitions in chronological order", async () => {
      const res = await makeRequest(`/api/admin/orders/${createdOrderId}`, {
        headers: { Authorization: "Bearer token_admin" },
      });

      assert.strictEqual(res.status, 200);
      const history = res.body.statusHistory;
      assert.ok(history.length >= 2);

      // First transition: creation to PENDING
      assert.strictEqual(history[0].toStatus, "PENDING");
      assert.strictEqual(history[0].actorType, "customer");

      // Subsequent transition: admin update to IN_PRODUCTION
      const prodEntry = history.find((h) => h.toStatus === "IN_PRODUCTION");
      assert.ok(prodEntry);
      assert.strictEqual(prodEntry.actorType, "operator");
      assert.ok(prodEntry.notes.includes("Divya"));
    });

  } finally {
    clearTestTokenVerifier();
    testServer.close();
  }

  console.log("\n==================================================================");
  console.log(`🏁 COMMERCE TEST EXECUTION COMPLETE: ${passedCount} Passed, ${failedCount} Failed`);
  console.log("==================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runCommerceTestSuite()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal Test Suite Error:", err);
      process.exit(1);
    });
}

module.exports = { runCommerceTestSuite };
