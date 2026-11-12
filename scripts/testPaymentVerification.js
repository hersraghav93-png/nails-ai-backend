/**
 * ==============================================================================
 * PHASE 5.1A PAYMENT VERIFICATION FOUNDATION TEST SUITE
 * (`scripts/testPaymentVerification.js`)
 *
 * Verifies:
 * 1. Authorized payment verification by Lead Artist Divya & Super Operator
 * 2. Unauthorized access defense (403 for Staff Artist lacking permission, 401 unauth)
 * 3. Invalid payment transitions (cannot revert VERIFIED to PENDING/FAILED, no cancelled orders)
 * 4. Repeated verification requests (idempotent 200 OK with alreadyVerified: true)
 * 5. Immutable audit log creation (action: ORDER_PAYMENT_VERIFIED with actor & diff)
 * 6. Order status history tracking (status_type: 'payment')
 * 7. Separation of payment status and order status (no silent payment changes in /status)
 * 8. Prevention of fulfilment progression before verified payment (IN_PRODUCTION / DISPATCHED blocked)
 * ==============================================================================
 */

"use strict";

process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const app = require("../index");
const { query, closePool } = require("../src/db/pool");
const {
  setTestTokenVerifier,
  clearTestTokenVerifier,
} = require("../src/services/firebaseService");

let server = null;
let baseUrl = null;

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function itAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  ❌ [FAIL] ${name}`);
    console.error(`     Error: ${err.message}\n`);
    if (err.stack) {
      console.error(err.stack.split("\n").slice(1, 4).join("\n"));
    }
  }
}

function makeRequest(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const method = options.method || "GET";
    const headers = options.headers || {};
    let bodyData = null;

    if (options.body) {
      bodyData = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyData);
    }

    const req = http.request(
      url,
      {
        method,
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let body = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            body = raw;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            raw,
          });
        });
      }
    );

    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function runPaymentVerificationSuite() {
  console.log("\n==================================================================");
  console.log("   NAILS BY DIVYA — PHASE 5.1A PAYMENT VERIFICATION TEST SUITE");
  console.log("==================================================================\n");

  const ts = Date.now();
  const SUPER_ADMIN_UID = `super_pay_${ts}`;
  const ARTIST_DIVYA_UID = `divya_pay_${ts}`;
  const STAFF_ARTIST_UID = `priya_staff_pay_${ts}`;
  const CUSTOMER_UID = `cust_pay_${ts}`;

  const SUPER_ADMIN_PHONE = `+919811${Math.floor(100000 + Math.random() * 900000)}`;
  const ARTIST_DIVYA_PHONE = `+919812${Math.floor(100000 + Math.random() * 900000)}`;
  const STAFF_ARTIST_PHONE = `+919813${Math.floor(100000 + Math.random() * 900000)}`;
  const CUSTOMER_PHONE = `+919814${Math.floor(100000 + Math.random() * 900000)}`;

  const mockUsers = {
    [SUPER_ADMIN_UID]: { uid: SUPER_ADMIN_UID, phoneNumber: SUPER_ADMIN_PHONE, disabled: false },
    [ARTIST_DIVYA_UID]: { uid: ARTIST_DIVYA_UID, phoneNumber: ARTIST_DIVYA_PHONE, disabled: false },
    [STAFF_ARTIST_UID]: { uid: STAFF_ARTIST_UID, phoneNumber: STAFF_ARTIST_PHONE, disabled: false },
    [CUSTOMER_UID]: { uid: CUSTOMER_UID, phoneNumber: CUSTOMER_PHONE, disabled: false },
  };

  setTestTokenVerifier(
    async (token) => {
      if (token === "token_super") {
        return { uid: SUPER_ADMIN_UID, phone_number: SUPER_ADMIN_PHONE, auth_time: Math.floor(Date.now() / 1000) };
      }
      if (token === "token_divya") {
        return { uid: ARTIST_DIVYA_UID, phone_number: ARTIST_DIVYA_PHONE, auth_time: Math.floor(Date.now() / 1000) };
      }
      if (token === "token_staff") {
        return { uid: STAFF_ARTIST_UID, phone_number: STAFF_ARTIST_PHONE, auth_time: Math.floor(Date.now() / 1000) };
      }
      if (token === "token_customer") {
        return { uid: CUSTOMER_UID, phone_number: CUSTOMER_PHONE, auth_time: Math.floor(Date.now() / 1000) };
      }
      return null;
    },
    async (uid) => mockUsers[uid] || null
  );

  // Helper to provision administrative account with assigned role
  async function provisionStaff(firebaseUid, phone, displayName, roleId) {
    const userRes = await query(
      `INSERT INTO users (firebase_uid, phone, is_active, created_at, updated_at)
       VALUES ($1, $2, TRUE, NOW(), NOW())
       ON CONFLICT (phone) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid
       RETURNING id;`,
      [firebaseUid, phone]
    );
    const userId = userRes.rows[0].id;

    await query(
      `INSERT INTO admin_profiles (user_id, display_name, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id) DO NOTHING;`,
      [userId, displayName]
    );

    await query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING;`,
      [userId, roleId]
    );

    return userId;
  }

  // Provision accounts
  const superId = await provisionStaff(SUPER_ADMIN_UID, SUPER_ADMIN_PHONE, "Super Operator Raghav", "super_operator");
  const divyaId = await provisionStaff(ARTIST_DIVYA_UID, ARTIST_DIVYA_PHONE, "Lead Artist Divya", "artist_divya");
  const staffId = await provisionStaff(STAFF_ARTIST_UID, STAFF_ARTIST_PHONE, "Assistant Artist Priya", "staff_artist");

  // Provision customer account
  const custRes = await query(
    `INSERT INTO users (firebase_uid, phone, is_active, created_at, updated_at)
     VALUES ($1, $2, TRUE, NOW(), NOW())
     RETURNING id;`,
    [CUSTOMER_UID, CUSTOMER_PHONE]
  );
  const custId = custRes.rows[0].id;

  // Helper to create an order
  async function createTestOrder(customSuffix = "") {
    const seqRes = await query(`SELECT nextval('order_number_seq') AS seq;`);
    const orderNumber = `NBD-ORD-PAY-${seqRes.rows[0].seq}${customSuffix}`;
    const insertRes = await query(
      `INSERT INTO orders (
         order_number, user_id, customer_name, customer_phone, customer_email,
         shipping_address, order_status, payment_status, fulfilment_status,
         subtotal, discount_amount, shipping_fee, total_amount, currency,
         customer_notes, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 'PENDING', 'UNFULFILLED',
                 1198.00, 0.00, 0.00, 1198.00, 'INR', 'Test bespoke order', NOW(), NOW())
       RETURNING *;`,
      [
        orderNumber,
        custId,
        "Ananya Roy",
        CUSTOMER_PHONE,
        "ananya@example.com",
        JSON.stringify({
          recipient_name: "Ananya Roy",
          phone: CUSTOMER_PHONE,
          address_line1: "Apt 4B, Lotus Boulevard",
          city: "Noida",
          state: "Uttar Pradesh",
          postal_code: "201304",
        }),
      ]
    );

    const ord = insertRes.rows[0];

    // Record initial status history
    await query(
      `INSERT INTO order_status_history (
         order_id, status_type, from_status, to_status, actor_type, actor_id, notes
       ) VALUES ($1, 'order', NULL, 'PENDING', 'customer', $2, 'Order placed via guest checkout');`,
      [ord.id, custId]
    );

    return ord;
  }

  // Start test server
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  try {
    // =========================================================================
    // 1. AUTHORIZED PAYMENT VERIFICATION
    // =========================================================================
    console.log("🧪 1. Authorized Payment Verification");

    const order1 = await createTestOrder("-AUTH-1");
    const testUtr1 = `UPI-UTR-${ts}-1`;

    await itAsync("Lead Artist Divya can verify customer payment with reference and notes", async () => {
      const res = await makeRequest(`/api/admin/orders/${order1.id}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          paymentStatus: "VERIFIED",
          paymentMethod: "manual_upi",
          transactionReference: testUtr1,
          amount: 1198.00,
          notes: "Confirmed ₹1,198 received in studio HDFC bank via Google Pay.",
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "success");
      assert.strictEqual(res.body.paymentStatus, "VERIFIED");
      assert.strictEqual(res.body.previousPaymentStatus, "PENDING");
      assert.strictEqual(res.body.alreadyVerified, false);
      assert.strictEqual(res.body.transactionReference, testUtr1);
      assert.strictEqual(res.body.paymentMethod, "manual_upi");
      assert.strictEqual(res.body.amount, 1198.00);

      // Verify orders table
      const orderCheck = await query(`SELECT payment_status FROM orders WHERE id = $1;`, [order1.id]);
      assert.strictEqual(orderCheck.rows[0].payment_status, "VERIFIED");

      // Verify payments ledger table
      const payCheck = await query(
        `SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1;`,
        [order1.id]
      );
      assert.strictEqual(payCheck.rows.length, 1);
      assert.strictEqual(payCheck.rows[0].status, "VERIFIED");
      assert.strictEqual(payCheck.rows[0].payment_method, "manual_upi");
      assert.strictEqual(payCheck.rows[0].gateway_payment_id, testUtr1);
      assert.strictEqual(parseFloat(payCheck.rows[0].amount), 1198.00);
      assert.ok(payCheck.rows[0].verified_at !== null);
    });

    const order2 = await createTestOrder("-AUTH-2");

    await itAsync("Super Operator can verify customer payment via POST alias", async () => {
      const res = await makeRequest(`/api/admin/orders/${order2.id}/verify-payment`, {
        method: "POST",
        headers: { Authorization: "Bearer token_super" },
        body: {
          payment_status: "VERIFIED",
          payment_method: "cash",
          amount: 1198.00,
          notes: "Cash deposit collected by studio assistant.",
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.paymentStatus, "VERIFIED");
      assert.strictEqual(res.body.paymentMethod, "cash");

      const dbCheck = await query(`SELECT payment_status FROM orders WHERE id = $1;`, [order2.id]);
      assert.strictEqual(dbCheck.rows[0].payment_status, "VERIFIED");
    });

    // =========================================================================
    // 2. UNAUTHORIZED ACCESS BOUNDARIES
    // =========================================================================
    console.log("\n🧪 2. Unauthorized Access & RBAC Boundaries");

    const order3 = await createTestOrder("-RBAC-1");

    await itAsync("Staff Artist (lacking orders:verify_payment) is rejected with 403 Forbidden", async () => {
      const res = await makeRequest(`/api/admin/orders/${order3.id}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_staff" },
        body: {
          paymentStatus: "VERIFIED",
        },
      });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_PERMISSION");

      // Verify payment status was NOT modified
      const check = await query(`SELECT payment_status FROM orders WHERE id = $1;`, [order3.id]);
      assert.strictEqual(check.rows[0].payment_status, "PENDING");
    });

    await itAsync("Regular customer is rejected with 403 FORBIDDEN_ROLE", async () => {
      const res = await makeRequest(`/api/admin/orders/${order3.id}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_customer" },
        body: {
          paymentStatus: "VERIFIED",
        },
      });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_ROLE");
    });

    await itAsync("Unauthenticated visitor is rejected with 401 AUTH_REQUIRED", async () => {
      const res = await makeRequest(`/api/admin/orders/${order3.id}/payment-status`, {
        method: "PATCH",
        body: {
          paymentStatus: "VERIFIED",
        },
      });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, "AUTH_REQUIRED");
    });

    // =========================================================================
    // 3. INVALID TRANSITIONS & INPUT VALIDATION
    // =========================================================================
    console.log("\n🧪 3. State Transitions & Input Validation");

    await itAsync("Cannot revert a VERIFIED payment back to PENDING", async () => {
      const res = await makeRequest(`/api/admin/orders/${order1.id}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          paymentStatus: "PENDING",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_PAYMENT_TRANSITION");
    });

    await itAsync("Cannot revert a VERIFIED payment back to FAILED without formal refund", async () => {
      const res = await makeRequest(`/api/admin/orders/${order1.id}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          paymentStatus: "FAILED",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_PAYMENT_TRANSITION");
    });

    await itAsync("Cannot verify payment on an already CANCELLED order", async () => {
      const cancelledOrder = await createTestOrder("-CANCELLED");
      await query(`UPDATE orders SET order_status = 'CANCELLED' WHERE id = $1;`, [cancelledOrder.id]);

      const res = await makeRequest(`/api/admin/orders/${cancelledOrder.id}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          paymentStatus: "VERIFIED",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "ORDER_ALREADY_CANCELLED");
    });

    await itAsync("Rejects invalid payment status string with 400 INVALID_PAYMENT_STATUS", async () => {
      const res = await makeRequest(`/api/admin/orders/${order3.id}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          paymentStatus: "SUPER_PAID",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_PAYMENT_STATUS");
    });

    await itAsync("Rejects invalid payment method with 400 INVALID_PAYMENT_METHOD", async () => {
      const res = await makeRequest(`/api/admin/orders/${order3.id}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          paymentStatus: "VERIFIED",
          paymentMethod: "crypto_token",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_PAYMENT_METHOD");
    });

    // =========================================================================
    // 4. REPEATED VERIFICATION REQUESTS (IDEMPOTENCY)
    // =========================================================================
    console.log("\n🧪 4. Idempotency & Repeated Requests");

    await itAsync("Repeated verification returns 200 OK with alreadyVerified: true", async () => {
      const res = await makeRequest(`/api/admin/orders/${order1.id}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          paymentStatus: "VERIFIED",
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.alreadyVerified, true);
      assert.strictEqual(res.body.paymentStatus, "VERIFIED");
      assert.ok(res.body.message.includes("already"));
    });

    // =========================================================================
    // 5. AUDIT LOGGING & ORDER STATUS HISTORY
    // =========================================================================
    console.log("\n🧪 5. Audit Logging & Order Status History");

    await itAsync("Verification creates audit_logs entry with actor, action, and diff", async () => {
      const auditRes = await query(
        `SELECT * FROM audit_logs 
         WHERE target_id = $1 AND action = 'ORDER_PAYMENT_VERIFIED'
         ORDER BY created_at DESC LIMIT 1;`,
        [order1.id]
      );

      assert.strictEqual(auditRes.rows.length, 1);
      const log = auditRes.rows[0];
      assert.strictEqual(log.actor_id, divyaId);
      assert.strictEqual(log.actor_role, "artist_divya");
      assert.strictEqual(log.target_entity, "orders");

      const diff = typeof log.diff === "string" ? JSON.parse(log.diff) : log.diff;
      assert.strictEqual(diff.previous.payment_status, "PENDING");
      assert.strictEqual(diff.updated.payment_status, "VERIFIED");
      assert.strictEqual(diff.updated.transaction_reference, testUtr1);
    });

    await itAsync("Verification appends record in order_status_history with status_type = 'payment'", async () => {
      const histRes = await query(
        `SELECT * FROM order_status_history
         WHERE order_id = $1 AND status_type = 'payment'
         ORDER BY created_at DESC LIMIT 1;`,
        [order1.id]
      );

      assert.strictEqual(histRes.rows.length, 1);
      const h = histRes.rows[0];
      assert.strictEqual(h.from_status, "PENDING");
      assert.strictEqual(h.to_status, "VERIFIED");
      assert.strictEqual(h.status_type, "payment");
      assert.strictEqual(h.actor_type, "operator");
      assert.strictEqual(h.actor_id, divyaId);
    });

    // =========================================================================
    // 6. SEPARATION OF PAYMENT STATUS AND ORDER STATUS
    // =========================================================================
    console.log("\n🧪 6. Separation of Payment Status and Order Status");

    const order4 = await createTestOrder("-SEP-1");

    await itAsync("Attempting to pass paymentStatus to /orders/:id/status fails with 400", async () => {
      const res = await makeRequest(`/api/admin/orders/${order4.id}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          orderStatus: "CONFIRMED",
          paymentStatus: "VERIFIED",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PAYMENT_STATUS_SEPARATE_MUTATION");

      // Verify payment remains strictly PENDING
      const check = await query(`SELECT payment_status, order_status FROM orders WHERE id = $1;`, [order4.id]);
      assert.strictEqual(check.rows[0].payment_status, "PENDING");
      assert.strictEqual(check.rows[0].order_status, "PENDING");
    });

    await itAsync("Normal order status update to CONFIRMED leaves payment strictly untouched", async () => {
      const res = await makeRequest(`/api/admin/orders/${order4.id}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          orderStatus: "CONFIRMED",
          notes: "Nail sizing verified with customer on WhatsApp.",
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.order.orderStatus, "CONFIRMED");
      assert.strictEqual(res.body.order.paymentStatus, "PENDING");

      const check = await query(`SELECT payment_status, order_status FROM orders WHERE id = $1;`, [order4.id]);
      assert.strictEqual(check.rows[0].payment_status, "PENDING");
      assert.strictEqual(check.rows[0].order_status, "CONFIRMED");
    });

    // =========================================================================
    // 7. PREVENTION OF FULFILMENT PROGRESSION BEFORE VERIFIED PAYMENT
    // =========================================================================
    console.log("\n🧪 7. Prevention of Fulfilment Progression Before Verified Payment");

    const order5 = await createTestOrder("-SAFETY-1");

    await itAsync("Moving unverified order to IN_PRODUCTION is rejected with 400 PAYMENT_NOT_VERIFIED", async () => {
      const res = await makeRequest(`/api/admin/orders/${order5.id}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          orderStatus: "IN_PRODUCTION",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PAYMENT_NOT_VERIFIED");

      const check = await query(`SELECT order_status FROM orders WHERE id = $1;`, [order5.id]);
      assert.strictEqual(check.rows[0].order_status, "PENDING");
    });

    await itAsync("Advancing unverified order fulfilment to READY_FOR_DISPATCH is rejected with 400", async () => {
      const res = await makeRequest(`/api/admin/orders/${order5.id}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          fulfilmentStatus: "READY_FOR_DISPATCH",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PAYMENT_NOT_VERIFIED");
    });

    await itAsync("Advancing unverified order fulfilment to DISPATCHED is rejected with 400", async () => {
      const res = await makeRequest(`/api/admin/orders/${order5.id}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          fulfilmentStatus: "DISPATCHED",
          courierName: "Delhivery Surface",
          trackingNumber: "DLV11223344",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PAYMENT_NOT_VERIFIED");
    });

    await itAsync("After payment verification, advancing to IN_PRODUCTION and DISPATCHED succeeds", async () => {
      // Step A: Verify payment
      const payRes = await makeRequest(`/api/admin/orders/${order5.id}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          paymentStatus: "VERIFIED",
          paymentMethod: "manual_upi",
          transactionReference: `UPI-SAFETY-${Date.now()}-999`,
          notes: "Payment verified in full.",
        },
      });
      assert.strictEqual(payRes.status, 200);
      assert.strictEqual(payRes.body.paymentStatus, "VERIFIED");

      // Step B: Advance to IN_PRODUCTION
      const prodRes = await makeRequest(`/api/admin/orders/${order5.id}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          orderStatus: "IN_PRODUCTION",
          fulfilmentStatus: "READY_FOR_DISPATCH",
          notes: "Bespoke builder gel sets now being handcrafted.",
        },
      });
      assert.strictEqual(prodRes.status, 200);
      assert.strictEqual(prodRes.body.order.orderStatus, "IN_PRODUCTION");
      assert.strictEqual(prodRes.body.order.fulfilmentStatus, "READY_FOR_DISPATCH");

      // Step C: Advance to DISPATCHED
      const dispatchRes = await makeRequest(`/api/admin/orders/${order5.id}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          fulfilmentStatus: "DISPATCHED",
          courierName: "Blue Dart Express",
          trackingNumber: "BD99887766",
          trackingUrl: "https://bluedart.com/BD99887766",
        },
      });
      assert.strictEqual(dispatchRes.status, 200);
      assert.strictEqual(dispatchRes.body.order.fulfilmentStatus, "DISPATCHED");
      assert.strictEqual(dispatchRes.body.order.courierName, "Blue Dart Express");
    });

  } finally {
    clearTestTokenVerifier();
    if (server) {
      await new Promise((r) => server.close(r));
    }
  }

  console.log("\n==================================================================");
  console.log(`🏁 PAYMENT VERIFICATION SUITE COMPLETE: ${passedTests} Passed, ${failedTests} Failed`);
  console.log("==================================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runPaymentVerificationSuite()
    .then(() => {
      closePool();
      process.exit(0);
    })
    .catch((err) => {
      console.error("FATAL SUITE ERROR:", err);
      closePool();
      process.exit(1);
    });
}

module.exports = { runPaymentVerificationSuite };
