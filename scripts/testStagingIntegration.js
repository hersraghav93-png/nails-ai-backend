/**
 * ==============================================================================
 * STAGING INTEGRATION & SMOKE TEST SUITE (`scripts/testStagingIntegration.js`)
 * Nails by Divya Platform — Phase 4A Staging Integration
 *
 * Comprehensive end-to-end smoke verification covering:
 * 1. Firebase Phone Authentication & Identity Resolution
 * 2. Product Catalogue & 22-SKU Verification
 * 3. Guest Cart & Authenticated Cart Claiming
 * 4. Pending Order Creation (Payment strictly PENDING / disabled)
 * 5. At-Home Appointment Request (REQUESTED status)
 * 6. Admin Authentication & PostgreSQL Role Resolution
 * 7. Admin Order Processing & Fulfilment Lifecycle
 * 8. Appointment Confirmation & Slot Locking
 * 9. Official Meta WhatsApp Cloud API (Graph API v26.0) & Webhooks
 *    (Challenge verification, HMAC SHA-256, SENT -> DELIVERED -> FAILED)
 * 10. Customer Account History & Cross-Customer Isolation
 * ==============================================================================
 */

"use strict";

process.env.NODE_ENV = "test";

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");
const CONFIG = require("../src/config");
const app = require("../index");
const { query, checkHealth } = require("../src/db/pool");
const { setTestTokenVerifier, clearTestTokenVerifier, verifyIdToken } = require("../src/services/firebaseService");
const { getOrCreateCart, addItemToCart, getCartDetails, claimGuestCart } = require("../src/services/cartService");
const { createOrderFromCart, getOrderById } = require("../src/services/orderService");
const { createAppointmentRequest, confirmAppointment, getAppointmentById } = require("../src/services/bookingService");
const { sendWhatsAppNotification, verifyWebhookSignature } = require("../src/services/notifications/whatsappAdapter");

let server;
let baseUrl;
let testsPassed = 0;
let testsFailed = 0;

function it(desc, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${desc}`);
      testsPassed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${desc}: ${err.message}`);
      testsFailed++;
    }
  })();
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = options.headers || {};
    let body = options.body;

    if (body && typeof body === "object" && !(body instanceof Buffer)) {
      body = JSON.stringify(body);
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    }

    const req = http.request(
      url,
      {
        method: options.method || "GET",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = raw;
          try {
            data = JSON.parse(raw);
          } catch {
            // keep as text
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data,
            raw,
          });
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runStagingSmokeTests() {
  console.log("===============================================================================");
  console.log("   NAILS BY DIVYA — STAGING ENVIRONMENT SMOKE & INTEGRATION SUITE (PHASE 4A)");
  console.log("===============================================================================");

  // Start test server
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`📡 [Test Server] Running on ${baseUrl} (env: ${CONFIG.nodeEnv})\n`);

  try {
    // --------------------------------------------------------------------------
    // TEST 1: FIREBASE STAGING AUTHENTICATION READINESS & ROLE RESOLUTION
    // --------------------------------------------------------------------------
    console.log("▶ [Test 1] Firebase Staging Authentication & Identity Verification");

    await it("Staging fails closed when Firebase credentials are not configured", async () => {
      // In staging mode with no credentials, verifyIdToken must reject with AUTH_SERVICE_UNCONFIGURED
      const originalEnv = CONFIG.nodeEnv;
      CONFIG.nodeEnv = "staging";
      try {
        let rejected = false;
        try {
          await verifyIdToken("unconfigured_staging_token_xyz");
        } catch (err) {
          rejected = true;
          assert.strictEqual(err.code, "AUTH_SERVICE_UNCONFIGURED");
          assert.strictEqual(err.statusCode, 503);
        }
        assert.strictEqual(rejected, true, "Unconfigured Firebase in staging must fail closed (503)");
      } finally {
        CONFIG.nodeEnv = originalEnv;
      }
    });

    await it("Simulator tokens are strictly forbidden in staging/live environments", async () => {
      const originalEnv = CONFIG.nodeEnv;
      CONFIG.nodeEnv = "staging";
      try {
        let blocked = false;
        try {
          await verifyIdToken("mock-super-admin-token");
        } catch (err) {
          blocked = true;
          assert.strictEqual(err.code, "INVALID_TOKEN");
          assert.strictEqual(err.statusCode, 401);
        }
        assert.strictEqual(blocked, true, "Simulator tokens must be rejected in staging");
      } finally {
        CONFIG.nodeEnv = originalEnv;
      }
    });

    // Controlled test token verifier for remaining automated smoke tests
    const testCustomerUid = `stage_cust_${Date.now()}`;
    const testCustomerPhone = `+9198144${Math.floor(10000 + Math.random() * 90000)}`;
    const testAdminUid = `stage_admin_${Date.now()}`;
    const testAdminPhone = `+9198155${Math.floor(10000 + Math.random() * 90000)}`;

    setTestTokenVerifier(async (token) => {
      if (token === "valid-staging-customer-token") {
        return {
          uid: testCustomerUid,
          phone_number: testCustomerPhone,
          auth_time: Math.floor(Date.now() / 1000),
        };
      }
      if (token === "valid-staging-admin-token") {
        return {
          uid: testAdminUid,
          phone_number: testAdminPhone,
          auth_time: Math.floor(Date.now() / 1000),
        };
      }
      return null;
    });

    let customerUser;
    await it("Customer identity resolves and provisions PostgreSQL customer record", async () => {
      const res = await request("/api/auth/me", {
        headers: { Authorization: "Bearer valid-staging-customer-token" },
      });
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert.strictEqual(res.body.status, "success");
      assert.strictEqual(res.body.user.phone, testCustomerPhone);
      assert(Array.isArray(res.body.user.roles));
      customerUser = res.body.user;
    });

    // --------------------------------------------------------------------------
    // TEST 2: PRODUCT CATALOGUE & 22-SKU VERIFICATION
    // --------------------------------------------------------------------------
    console.log("\n▶ [Test 2] Product Catalogue & Pricing Verification");

    await it("GET /api/products returns all 22 active handcrafted press-on nail sets", async () => {
      const res = await request("/api/products");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.total, 22, `Expected 22 products, got ${res.body.total}`);
      assert(Array.isArray(res.body.products));

      // Verify festive offer
      const rosewood = res.body.products.find((p) => p.sku === "WED-005");
      assert(rosewood, "WED-005 Rosewood Bloom found");
      assert.strictEqual(rosewood.effectivePrice, 599, "Promotional price is ₹599");
    });

    await it("GET /api/services preserves NULL pricing for custom quotation services", async () => {
      const res = await request("/api/services");
      assert.strictEqual(res.status, 200);
      assert(Array.isArray(res.body.services));
      const custom3d = res.body.services.find((s) => s.id === "custom_3d_art");
      assert(custom3d, "3D & Custom Nail Art service found");
      assert.strictEqual(custom3d.basePrice, null, "3D Art basePrice must be NULL");
      assert.strictEqual(custom3d.isCustomQuote, true);
    });

    // --------------------------------------------------------------------------
    // TEST 3: GUEST CART & AUTHENTICATED CART CLAIMING
    // --------------------------------------------------------------------------
    console.log("\n▶ [Test 3] Shopping Cart Lifecycle & Guest Cart Claiming");

    let guestSessionToken = `staging_guest_${Date.now()}`;
    let createdCart;

    await it("Guest adds handcrafted set to shopping cart with custom sizing", async () => {
      const cartRes = await getOrCreateCart(guestSessionToken, null);
      createdCart = cartRes;

      const priced = await addItemToCart(createdCart.id, {
        sku: "WED-005",
        quantity: 1,
        shape: "Almond",
        length: "Medium",
        sizePreset: "Custom",
        customMeasurements: { thumb: 16, index: 12, middle: 13, ring: 11, pinky: 9 },
      });

      assert.strictEqual(priced.items.length, 1);
      assert.strictEqual(priced.totals.totalAmount, 599);
      assert.strictEqual(priced.totals.shippingFee, 0, "Delivery fee baseline is ₹0 (confirmed by studio)");
    });

    await it("Authenticated customer claims guest cart ownership", async () => {
      const claimed = await claimGuestCart(guestSessionToken, customerUser.id);
      assert.strictEqual(claimed.user_id, customerUser.id, "Cart ownership transferred to customer");

      const claimedDetails = await getCartDetails(claimed.id);
      assert.strictEqual(claimedDetails.items.length, 1);
      assert.strictEqual(claimedDetails.items[0].sku, "WED-005");
    });

    // --------------------------------------------------------------------------
    // TEST 4: PENDING ORDER CREATION (PAYMENTS DISABLED / PENDING)
    // --------------------------------------------------------------------------
    console.log("\n▶ [Test 4] Order Creation & Strictly PENDING Status Enforcement");

    let placedOrder;
    await it("Creates order in strictly PENDING status with disabled payments", async () => {
      const orderRes = await createOrderFromCart({
        cartId: createdCart.id,
        userId: customerUser.id,
        customer: {
          fullName: "Staging Test Customer",
          phone: testCustomerPhone,
          email: "staging-customer@nailsbydivya.store",
        },
        shippingAddress: {
          recipientName: "Staging Test Customer",
          phone: testCustomerPhone,
          addressLine1: "Flat 402, DLF Phase 5",
          city: "Gurugram",
          state: "Haryana",
          postalCode: "122009",
        },
      });

      assert(orderRes.order);
      assert.strictEqual(orderRes.order.orderStatus, "PENDING", "Order status must be strictly PENDING");
      assert.strictEqual(orderRes.order.paymentStatus, "PENDING", "Payment status must be strictly PENDING");
      assert.strictEqual(orderRes.order.totalAmount, 599);
      placedOrder = orderRes.order;
    });

    // --------------------------------------------------------------------------
    // TEST 5: AT-HOME APPOINTMENT REQUEST (REQUESTED STATUS)
    // --------------------------------------------------------------------------
    console.log("\n▶ [Test 5] At-Home Appointment Request Flow");

    let createdBooking;
    await it("Creates at-home salon appointment request in REQUESTED status", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 2);
      const slotDate = tomorrow.toISOString().split("T")[0];

      const addonRes = await query("SELECT id FROM service_addons WHERE service_id = 'gel_extensions' LIMIT 1;");
      const addonId = addonRes.rows[0].id;

      const bookingRes = await createAppointmentRequest({
        userId: customerUser.id,
        serviceId: "gel_extensions",
        addonIds: [addonId],
        requestedDate: slotDate,
        requestedTimeSlot: "12:30 PM - 02:30 PM",
        customer: {
          fullName: "Staging Test Customer",
          phone: testCustomerPhone,
          email: "staging-customer@nailsbydivya.store",
        },
        serviceAddress: {
          addressLine1: "Villa 12, Nirvana Country, Sector 50",
          city: "Gurugram",
          state: "Haryana",
          postalCode: "122018",
        },
      });

      assert(bookingRes.booking);
      assert.strictEqual(bookingRes.booking.bookingStatus, "REQUESTED", "Booking status must be REQUESTED");
      createdBooking = bookingRes.booking;
    });

    // --------------------------------------------------------------------------
    // TEST 6: ADMIN AUTHENTICATION & POSTGRESQL ROLE RESOLUTION
    // --------------------------------------------------------------------------
    console.log("\n▶ [Test 6] Admin Authentication & Role Enforcement");

    await it("Regular customer is rejected from administrative endpoints with 403 FORBIDDEN_ROLE", async () => {
      const res = await request("/api/admin/overview", {
        headers: { Authorization: "Bearer valid-staging-customer-token" },
      });
      assert.strictEqual(res.status, 403, `Expected 403, got ${res.status}`);
      assert.strictEqual(res.body.code, "FORBIDDEN_ROLE");
    });

    await it("Verified admin user can access administrative overview", async () => {
      // Provision test admin role in PostgreSQL for testAdminPhone
      const userRes = await query(
        `INSERT INTO users (phone, firebase_uid, is_active)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (phone) DO UPDATE SET firebase_uid = $2
         RETURNING id;`,
        [testAdminPhone, testAdminUid]
      );
      const adminUserId = userRes.rows[0].id;

      // Assign admin profile and super_operator role
      await query(
        `INSERT INTO admin_profiles (user_id, display_name)
         VALUES ($1, 'Staging Admin')
         ON CONFLICT (user_id) DO NOTHING;`,
        [adminUserId]
      );

      await query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, 'super_operator')
         ON CONFLICT (user_id, role_id) DO NOTHING;`,
        [adminUserId]
      );

      const res = await request("/api/admin/overview", {
        headers: { Authorization: "Bearer valid-staging-admin-token" },
      });
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert(res.body.overview);
      assert(typeof res.body.overview.totalOrders === "number");
    });

    // --------------------------------------------------------------------------
    // TEST 7: ADMIN ORDER PROCESSING LIFECYCLE
    // --------------------------------------------------------------------------
    console.log("\n▶ [Test 7] Admin Order Fulfilment Lifecycle");

    await it("Admin can update order status with audit trail", async () => {
      const res = await request(`/api/admin/orders/${placedOrder.id}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer valid-staging-admin-token" },
        body: {
          orderStatus: "CONFIRMED",
          notes: "Sizing verified on WhatsApp with customer. Delivery scheduled.",
        },
      });

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert.strictEqual(res.body.order.orderStatus, "CONFIRMED");

      // Verify audit log
      const auditRes = await query(
        `SELECT * FROM audit_logs WHERE target_id = $1 ORDER BY created_at DESC LIMIT 1;`,
        [placedOrder.id]
      );
      assert(auditRes.rows.length > 0, "Audit log entry recorded for admin action");
      assert.strictEqual(auditRes.rows[0].action, "ORDER_STATUS_UPDATED");
    });

    // --------------------------------------------------------------------------
    // TEST 8: APPOINTMENT CONFIRMATION & SLOT LOCKING
    // --------------------------------------------------------------------------
    console.log("\n▶ [Test 8] Appointment Confirmation Controls");

    await it("Admin can confirm appointment request, locking schedule window", async () => {
      const startTime = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
      const endTime = new Date(Date.now() + (2 * 24 + 2) * 3600 * 1000).toISOString();

      const res = await request(`/api/admin/bookings/${createdBooking.id}/confirm`, {
        method: "PATCH",
        headers: { Authorization: "Bearer valid-staging-admin-token" },
        body: {
          confirmed_start_time: startTime,
          confirmed_end_time: endTime,
          notes: "Confirmed for Delhi NCR at-home salon service.",
        },
      });

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert.strictEqual(res.body.booking.bookingStatus, "CONFIRMED");
    });

    // --------------------------------------------------------------------------
    // TEST 9: META WHATSAPP CLOUD API (v26.0) & WEBHOOK DELIVERY TRACKING
    // --------------------------------------------------------------------------
    console.log("\n▶ [Test 9] WhatsApp Cloud API (Graph API v26.0) & Webhooks");

    await it("Graph API version is configured to v26.0 (v18.0 deprecation check)", () => {
      assert.strictEqual(CONFIG.notifications.whatsapp.apiVersion, "v26.0");
    });

    await it("Staging safety filter blocks dispatch to unapproved customer recipients", async () => {
      const originalEnv = CONFIG.nodeEnv;
      CONFIG.nodeEnv = "staging";
      try {
        const dispatchRes = await sendWhatsAppNotification({
          recipientPhone: "+919999988888", // Unapproved real customer number
          text: "Test notification",
          templateName: "order_confirmed",
        });

        assert.strictEqual(dispatchRes.success, false);
        assert.strictEqual(dispatchRes.deliveryStatus, "FAILED");
        assert.strictEqual(dispatchRes.errorCode, "STAGING_RECIPIENT_NOT_APPROVED");
      } finally {
        CONFIG.nodeEnv = originalEnv;
      }
    });

    const testAppSecret = "staging_meta_app_secret_test_xyz123";
    const testVerifyToken = "staging_verify_token_secure_456";

    await it("GET /api/webhooks/whatsapp verifies challenge with matching verify_token", async () => {
      const origToken = CONFIG.notifications.whatsapp.webhookVerifyToken;
      CONFIG.notifications.whatsapp.webhookVerifyToken = testVerifyToken;
      try {
        const res = await request(
          `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${testVerifyToken}&hub.challenge=CHALLENGE_ACCEPTED_789`
        );
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.raw, "CHALLENGE_ACCEPTED_789");

        const badRes = await request(
          `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=123`
        );
        assert.strictEqual(badRes.status, 403);
      } finally {
        CONFIG.notifications.whatsapp.webhookVerifyToken = origToken;
      }
    });

    await it("POST /api/webhooks/whatsapp validates X-Hub-Signature-256 HMAC SHA-256", async () => {
      const origSecret = CONFIG.notifications.whatsapp.appSecret;
      CONFIG.notifications.whatsapp.appSecret = testAppSecret;

      try {
        const webhookPayload = JSON.stringify({
          object: "whatsapp_business_account",
          entry: [],
        });

        // Compute valid signature
        const hmac = crypto.createHmac("sha256", testAppSecret);
        hmac.update(webhookPayload);
        const validSignature = `sha256=${hmac.digest("hex")}`;

        const validRes = await request("/api/webhooks/whatsapp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-hub-signature-256": validSignature,
          },
          body: webhookPayload,
        });
        assert.strictEqual(validRes.status, 200);

        // Test invalid signature
        const invalidRes = await request("/api/webhooks/whatsapp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-hub-signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
          },
          body: webhookPayload,
        });
        assert.strictEqual(invalidRes.status, 401);
        assert.strictEqual(invalidRes.body.code, "INVALID_WEBHOOK_SIGNATURE");
      } finally {
        CONFIG.notifications.whatsapp.appSecret = origSecret;
      }
    });

    await it("Webhook status delivery receipts update notification logs: SENT -> DELIVERED -> FAILED", async () => {
      // Create a test notification job & delivery log
      const testJobRes = await query(
        `INSERT INTO notification_jobs (
           channel, recipient_phone, template_name, template_variables, status, idempotency_key
         ) VALUES ('whatsapp', $1, 'order_confirmed', '{"test":true}', 'SENT', $2)
         RETURNING id;`,
        [testCustomerPhone, `notif_webhook_test_${Date.now()}`]
      );
      const testJobId = testJobRes.rows[0].id;
      const testProviderMsgId = `wamid.HBgL${Date.now()}`;

      await query(
        `INSERT INTO notification_delivery_logs (
           job_id, provider_message_id, delivery_status
         ) VALUES ($1, $2, 'SENT');`,
        [testJobId, testProviderMsgId]
      );

      // Simulate inbound DELIVERED status webhook from Meta
      const deliveredPayload = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_ID_123",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  statuses: [
                    {
                      id: testProviderMsgId,
                      status: "delivered",
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      recipient_id: testCustomerPhone.replace(/\D/g, ""),
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      const delivRes = await request("/api/webhooks/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: deliveredPayload,
      });
      assert.strictEqual(delivRes.status, 200);

      // Verify delivery log updated to DELIVERED
      const updatedLog = await query(
        `SELECT delivery_status FROM notification_delivery_logs WHERE provider_message_id = $1;`,
        [testProviderMsgId]
      );
      assert.strictEqual(updatedLog.rows[0].delivery_status, "DELIVERED");

      // Simulate inbound FAILED status webhook from Meta
      const failedPayload = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_ID_123",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  statuses: [
                    {
                      id: testProviderMsgId,
                      status: "failed",
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      errors: [{ code: 131026, title: "Message undeliverable" }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      const failRes = await request("/api/webhooks/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: failedPayload,
      });
      assert.strictEqual(failRes.status, 200);

      const failedLog = await query(
        `SELECT delivery_status, error_code FROM notification_delivery_logs WHERE provider_message_id = $1;`,
        [testProviderMsgId]
      );
      assert.strictEqual(failedLog.rows[0].delivery_status, "FAILED");
      assert.strictEqual(failedLog.rows[0].error_code, "131026");
    });

    // --------------------------------------------------------------------------
    // TEST 10: CUSTOMER ACCOUNT HISTORY & CROSS-CUSTOMER ISOLATION
    // --------------------------------------------------------------------------
    console.log("\n▶ [Test 10] Customer Account History & Security Isolation");

    await it("Customer retrieves placed order in their account order history", async () => {
      const res = await request("/api/orders", {
        headers: { Authorization: "Bearer valid-staging-customer-token" },
      });
      assert.strictEqual(res.status, 200);
      assert(Array.isArray(res.body.orders));
      const found = res.body.orders.find((o) => o.id === placedOrder.id);
      assert(found, "Customer order found in customer history");
    });

    await it("Cross-customer isolation blocks third-party users from accessing the order", async () => {
      let blocked = false;
      try {
        await getOrderById(placedOrder.id, {
          userId: "00000000-0000-0000-0000-000000000000",
          claimSecret: null,
        });
      } catch (err) {
        blocked = true;
        assert(err.message.includes("Access denied") || err.code === "FORBIDDEN_ORDER_ACCESS");
      }
      assert.strictEqual(blocked, true, "Cross-customer access without credentials must be blocked");
    });

    console.log("\n===============================================================================");
    console.log(`🏁 STAGING INTEGRATION SUITE FINISHED: ${testsPassed} Passed, ${testsFailed} Failed`);
    console.log("===============================================================================\n");
  } finally {
    clearTestTokenVerifier();
    server.close();
  }

  if (testsFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runStagingSmokeTests().catch((err) => {
  console.error("FATAL SUITE ERROR:", err);
  process.exit(1);
});
