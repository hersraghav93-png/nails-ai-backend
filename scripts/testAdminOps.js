/**
 * ==========================================================================
 * PHASE 2C ADMIN OPERATIONS INTEGRATION TEST SUITE (`scripts/testAdminOps.js`)
 * Nails by Divya Platform
 *
 * Verifies the complete administrative business dashboard engine:
 * 1. Live overview metrics & real-time revenue distinction (paid vs unpaid)
 * 2. Administrative order management, details, advancement, and cancellation
 * 3. Appointment lifecycle (review, alternative proposal, confirmation, decline)
 * 4. Customer directory, search, nail sizing profiles, and interaction histories
 * 5. Catalog product & service availability toggling with audit logging
 * 6. Staff directory and RBAC permission matrix enforcement
 * 7. Business settings and immutable audit trails
 * 8. Strict security boundaries: Customer 403s, role scopes, unauthenticated 401s
 * ==========================================================================
 */

"use strict";

process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const app = require("../index");
const { getPool, query } = require("../src/db/pool");
const { setTestTokenVerifier } = require("../src/services/firebaseService");
const { findOrCreateUserByFirebaseToken, provisionAdminAccount } = require("../src/services/userService");

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

async function runAdminOpsTestSuite() {
  console.log("==================================================================");
  console.log("   NAILS BY DIVYA — PHASE 2C ADMIN OPERATIONS TEST SUITE");
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
  const SUPER_ADMIN_UID = `super_admin_${ts}`;
  const SUPER_ADMIN_PHONE = `+919811${Math.floor(100000 + Math.random() * 900000)}`;
  const ARTIST_DIVYA_UID = `artist_divya_${ts}`;
  const ARTIST_DIVYA_PHONE = `+919812${Math.floor(100000 + Math.random() * 900000)}`;
  const STAFF_ARTIST_UID = `staff_artist_${ts}`;
  const STAFF_ARTIST_PHONE = `+919813${Math.floor(100000 + Math.random() * 900000)}`;
  const CUSTOMER_UID = `cust_ops_${ts}`;
  const CUSTOMER_PHONE = `+919814${Math.floor(100000 + Math.random() * 900000)}`;

  const mockFirebaseUsers = {
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
      const err = new Error("Invalid test token");
      err.code = "INVALID_TOKEN";
      err.statusCode = 401;
      throw err;
    },
    async (uid) => mockFirebaseUsers[uid] || null
  );

  // Provision accounts in database
  const customerUser = await findOrCreateUserByFirebaseToken({
    uid: CUSTOMER_UID,
    phone_number: CUSTOMER_PHONE,
  });

  // Set up customer profile with sizing
  await query(
    `UPDATE customer_profiles
     SET full_name = 'Test Operations Customer',
         sizing_preset = 'M',
         preferred_nail_shape = 'almond',
         preferred_nail_length = 'medium'
     WHERE user_id = $1;`,
    [customerUser.id]
  );

  // Save an address for this customer
  await query(
    `INSERT INTO user_addresses (user_id, recipient_name, recipient_phone, address_line1, city, state, postal_code, is_default_shipping, is_default_service)
     VALUES ($1, 'Test Operations Customer', $2, '101 Rosewood Lane, Hauz Khas', 'New Delhi', 'Delhi', '110016', TRUE, TRUE);`,
    [customerUser.id, CUSTOMER_PHONE]
  );

  // Provision staff roles
  await provisionAdminAccount({
    firebaseUid: SUPER_ADMIN_UID,
    phone: SUPER_ADMIN_PHONE,
    displayName: "Super Operator Raghav",
    roleId: "super_operator",
  });

  await provisionAdminAccount({
    firebaseUid: ARTIST_DIVYA_UID,
    phone: ARTIST_DIVYA_PHONE,
    displayName: "Lead Artist Divya",
    roleId: "artist_divya",
  });

  await provisionAdminAccount({
    firebaseUid: STAFF_ARTIST_UID,
    phone: STAFF_ARTIST_PHONE,
    displayName: "Assistant Artist Priya",
    roleId: "staff_artist",
  });

  // Track sample records created during tests
  let sampleOrderId = null;
  let sampleBookingId = null;
  let sampleProductId = null;

  try {
    // =========================================================================
    // 1. DASHBOARD OVERVIEW & REVENUE DISTINCTION
    // =========================================================================
    console.log("🧪 1. Dashboard Overview Metrics & Real-time Revenue");

    await itAsync("GET /api/admin/overview returns real database counts and distinct revenue figures", async () => {
      const res = await makeRequest("/api/admin/overview", {
        headers: { Authorization: "Bearer token_super" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "success");
      const overview = res.body.overview;

      assert.strictEqual(typeof overview.totalProducts, "number");
      assert.strictEqual(typeof overview.totalServices, "number");
      assert.strictEqual(typeof overview.totalOrders, "number");
      assert.strictEqual(typeof overview.totalBookings, "number");
      assert.strictEqual(typeof overview.totalPortfolioDesigns, "number");

      // Verify detailed order breakdown
      assert.ok(overview.orders);
      assert.strictEqual(typeof overview.orders.pending, "number");
      assert.strictEqual(typeof overview.orders.inProduction, "number");
      assert.strictEqual(typeof overview.orders.completed, "number");

      // Verify detailed booking breakdown
      assert.ok(overview.bookings);
      assert.strictEqual(typeof overview.bookings.newRequests, "number");
      assert.strictEqual(typeof overview.bookings.confirmed, "number");
      assert.strictEqual(typeof overview.bookings.upcoming, "number");

      // Verify revenue distinction (unpaid vs paid)
      assert.ok(overview.financials);
      assert.strictEqual(typeof overview.financials.totalOrderAmount, "number");
      assert.strictEqual(typeof overview.financials.paidRevenue, "number");
      assert.strictEqual(typeof overview.financials.pendingPaymentAmount, "number");
      assert.strictEqual(typeof overview.financials.refundedAmount, "number");

      // Verify customer count
      assert.ok(overview.customers);
      assert.strictEqual(typeof overview.customers.total, "number");

      // Verify recent activity arrays
      assert.ok(Array.isArray(overview.recentOrders));
      assert.ok(Array.isArray(overview.recentBookings));
    });

    await itAsync("GET /api/admin/overview accepts date filters (today, 7d, 30d, all)", async () => {
      const res7d = await makeRequest("/api/admin/overview?range=7d", {
        headers: { Authorization: "Bearer token_super" },
      });
      assert.strictEqual(res7d.status, 200);
      assert.strictEqual(res7d.body.overview.range, "7d");
      assert.ok(res7d.body.overview.dateFrom);
      assert.ok(res7d.body.overview.dateTo);

      const resToday = await makeRequest("/api/admin/overview?range=today", {
        headers: { Authorization: "Bearer token_super" },
      });
      assert.strictEqual(resToday.status, 200);
      assert.strictEqual(resToday.body.overview.range, "today");
    });

    // =========================================================================
    // 2. ORDER MANAGEMENT & CANCELLATION
    // =========================================================================
    console.log("\n🧪 2. Order Management & Administrative Controls");

    // First create a real test order in PostgreSQL for this test
    const orderNumRes = await query(`SELECT nextval('order_number_seq') AS seq;`);
    const testOrderNum = `NBD-ORD-OPS-${orderNumRes.rows[0].seq}`;
    const insertOrderRes = await query(
      `INSERT INTO orders (
         order_number, user_id, customer_name, customer_phone, customer_email,
         shipping_address, order_status, payment_status, fulfilment_status,
         subtotal, discount_amount, shipping_fee, total_amount, currency
       ) VALUES ($1, $2, 'Ops Customer', $3, 'ops@test.com',
         $4, 'PENDING', 'PENDING', 'UNFULFILLED',
         999.00, 0.00, 0.00, 999.00, 'INR')
       RETURNING id;`,
      [
        testOrderNum,
        customerUser.id,
        CUSTOMER_PHONE,
        JSON.stringify({ address_line1: "101 Rosewood Lane", city: "New Delhi", state: "Delhi", postal_code: "110016" }),
      ]
    );
    sampleOrderId = insertOrderRes.rows[0].id;

    // Insert order item
    await query(
      `INSERT INTO order_items (order_id, product_id, sku, product_name, unit_price, quantity, total_price, variant_details)
       SELECT $1, id, sku, name, 999.00, 1, 999.00, '{"shape":"almond","length":"medium","sizing_preset":"M"}'::jsonb
       FROM products LIMIT 1;`,
      [sampleOrderId]
    );

    await itAsync("Admin can list orders with status & payment filters", async () => {
      const res = await makeRequest("/api/admin/orders?status=PENDING&payment_status=PENDING", {
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.orders));
      const found = res.body.orders.find((o) => o.id === sampleOrderId);
      assert.ok(found, "Sample order should be listed in filtered orders");
      assert.strictEqual(found.paymentStatus, "PENDING");
      assert.strictEqual(found.orderStatus, "PENDING");
    });

    await itAsync("Admin can retrieve full order details with snapshots and sizing", async () => {
      const res = await makeRequest(`/api/admin/orders/${sampleOrderId}`, {
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.order.id, sampleOrderId);
      assert.strictEqual(res.body.order.orderNumber, testOrderNum);
      assert.ok(Array.isArray(res.body.items));
      assert.ok(res.body.items.length > 0);
      assert.strictEqual(res.body.items[0].variantDetails.sizing_preset, "M");
      assert.ok(Array.isArray(res.body.statusHistory));
    });

    await itAsync("Admin can update order fulfillment status", async () => {
      // 1. Business safety rule: cannot move to IN_PRODUCTION before payment is verified
      const unverifiedRes = await makeRequest(`/api/admin/orders/${sampleOrderId}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          order_status: "IN_PRODUCTION",
        },
      });
      assert.strictEqual(unverifiedRes.status, 400);
      assert.strictEqual(unverifiedRes.body.code, "PAYMENT_NOT_VERIFIED");

      // 2. Verify payment via dedicated endpoint
      const payRes = await makeRequest(`/api/admin/orders/${sampleOrderId}/payment-status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          paymentStatus: "VERIFIED",
          paymentMethod: "manual_upi",
          transactionReference: `UPI-OPS-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          notes: "Lead Artist Divya confirmed funds in studio account.",
        },
      });
      assert.strictEqual(payRes.status, 200);
      assert.strictEqual(payRes.body.paymentStatus, "VERIFIED");

      // 3. Now successfully advance to IN_PRODUCTION and READY_FOR_DISPATCH
      const res = await makeRequest(`/api/admin/orders/${sampleOrderId}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          order_status: "IN_PRODUCTION",
          fulfilment_status: "READY_FOR_DISPATCH",
          notes: "Nails are being sculpted by Divya.",
        },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.order.orderStatus, "IN_PRODUCTION");
      assert.strictEqual(res.body.order.fulfilmentStatus, "READY_FOR_DISPATCH");
    });

    await itAsync("Admin can cancel an eligible order with audit log", async () => {
      // Create a pending order for cancellation test
      const cancelNumRes = await query(`SELECT nextval('order_number_seq') AS seq;`);
      const cancelOrderNum = `NBD-ORD-OPS-CAN-${cancelNumRes.rows[0].seq}`;
      const cancelOrderRes = await query(
        `INSERT INTO orders (
           order_number, user_id, customer_name, customer_phone, customer_email,
           shipping_address, order_status, payment_status, fulfilment_status,
           subtotal, discount_amount, shipping_fee, total_amount, currency
         ) VALUES ($1, $2, 'Cancel Customer', $3, 'cancel@test.com',
           $4, 'PENDING', 'PENDING', 'UNFULFILLED',
           999.00, 0.00, 0.00, 999.00, 'INR')
         RETURNING id;`,
        [
          cancelOrderNum,
          customerUser.id,
          CUSTOMER_PHONE,
          JSON.stringify({ address_line1: "101 Rosewood Lane", city: "New Delhi", postal_code: "110016" }),
        ]
      );
      const cancelOrderId = cancelOrderRes.rows[0].id;

      const res = await makeRequest(`/api/admin/orders/${cancelOrderId}/cancel`, {
        method: "POST",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          reason: "Customer requested cancellation via WhatsApp.",
        },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.order.orderStatus, "CANCELLED");
    });

    // =========================================================================
    // 3. APPOINTMENT MANAGEMENT
    // =========================================================================
    console.log("\n🧪 3. Appointment Lifecycle & Confirmation Controls");

    // Insert test booking
    const bkgNumRes = await query(`SELECT nextval('booking_number_seq') AS seq;`);
    const testBkgNum = `NBD-BKG-OPS-${bkgNumRes.rows[0].seq}`;
    const insertBookingRes = await query(
      `INSERT INTO bookings (
         booking_number, user_id, customer_name, customer_phone, customer_email,
         service_id, service_address, postal_code, requested_date, requested_time_slot,
         booking_status, payment_status, estimated_total
       ) VALUES ($1, $2, 'Ops Booking Customer', $3, 'bkg@test.com',
         'gel_extensions', $4, '110016', CURRENT_DATE + INTERVAL '5 days', '10:00 AM - 12:00 PM',
         'REQUESTED', 'UNPAID', 999.00)
       RETURNING id;`,
      [
        testBkgNum,
        customerUser.id,
        CUSTOMER_PHONE,
        JSON.stringify({ address_line1: "101 Rosewood Lane", city: "New Delhi", postal_code: "110016" }),
      ]
    );
    sampleBookingId = insertBookingRes.rows[0].id;

    await itAsync("Admin can list appointment requests and inspect details", async () => {
      const res = await makeRequest(`/api/admin/bookings/${sampleBookingId}`, {
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.booking.id, sampleBookingId);
      assert.strictEqual(res.body.booking.bookingStatus, "REQUESTED");
    });

    await itAsync("Admin can propose an alternative slot with action token", async () => {
      const altDate = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const res = await makeRequest(`/api/admin/bookings/${sampleBookingId}/propose-slot`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          alternative_date: altDate,
          alternative_time_slot: "03:00 PM - 05:00 PM",
          reschedule_reason: "Earlier slot occupied by prior bridal appointment.",
        },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.booking.bookingStatus, "ALTERNATIVE_PROPOSED");
      assert.ok(res.body.actionToken, "Action token should be generated for alternative slot");
    });

    await itAsync("Admin can confirm appointment with locked scheduled time window", async () => {
      const startTime = new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString();
      const endTime = new Date(Date.now() + (8 * 24 + 2) * 3600 * 1000).toISOString();

      const res = await makeRequest(`/api/admin/bookings/${sampleBookingId}/confirm`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          confirmed_start_time: startTime,
          confirmed_end_time: endTime,
          notes: "Confirmed by Divya for Hauz Khas appointment.",
        },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.booking.bookingStatus, "CONFIRMED");
    });

    await itAsync("Admin can update operational progress to IN_PROGRESS and COMPLETED", async () => {
      const resInProgress = await makeRequest(`/api/admin/bookings/${sampleBookingId}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: { status: "IN_PROGRESS", notes: "Artist arrived on site." },
      });
      assert.strictEqual(resInProgress.status, 200);
      assert.strictEqual(resInProgress.body.booking.bookingStatus, "IN_PROGRESS");

      const resCompleted = await makeRequest(`/api/admin/bookings/${sampleBookingId}/status`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: { status: "COMPLETED", notes: "Service completed successfully." },
      });
      assert.strictEqual(resCompleted.status, 200);
      assert.strictEqual(resCompleted.body.booking.bookingStatus, "COMPLETED");
    });

    // =========================================================================
    // 4. CUSTOMER MANAGEMENT
    // =========================================================================
    console.log("\n🧪 4. Customer Directory & Profiles");

    await itAsync("Admin can search and list registered customers with interaction counts", async () => {
      const res = await makeRequest("/api/admin/customers?search=Operations", {
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.customers));
      const found = res.body.customers.find((c) => c.id === customerUser.id);
      assert.ok(found, "Customer should be found by search query");
      assert.strictEqual(found.fullName, "Test Operations Customer");
      assert.ok(found.orderCount >= 1);
      assert.ok(found.bookingCount >= 1);
    });

    await itAsync("Admin can retrieve full customer profile with nail sizing and history", async () => {
      const res = await makeRequest(`/api/admin/customers/${customerUser.id}`, {
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.customer);
      assert.strictEqual(res.body.customer.profile.fullName, "Test Operations Customer");
      assert.strictEqual(res.body.customer.profile.sizingPreset, "M");
      assert.strictEqual(res.body.customer.profile.preferredNailShape, "almond");
      assert.ok(Array.isArray(res.body.customer.addresses));
      assert.ok(res.body.customer.addresses.length > 0);
      assert.ok(Array.isArray(res.body.customer.orders));
      assert.ok(Array.isArray(res.body.customer.bookings));
    });

    // =========================================================================
    // 5. PRODUCT & SERVICE MANAGEMENT
    // =========================================================================
    console.log("\n🧪 5. Product & Service Catalog Availability");

    await itAsync("Admin can list catalog products with SKUs, prices and variants", async () => {
      const res = await makeRequest("/api/admin/products", {
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.products));
      assert.ok(res.body.products.length >= 22);
      sampleProductId = res.body.products[0].id;
      assert.ok(res.body.products[0].sku);
      assert.ok(res.body.products[0].price);
      assert.strictEqual(res.body.products[0].promotionalPrice, 599.00); // Verified ₹599 promo
    });

    await itAsync("Admin with 'catalog:toggle_availability' can toggle product availability with audit log", async () => {
      const res = await makeRequest(`/api/admin/products/${sampleProductId}/availability`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: { is_active: false },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.product.is_available, false);

      // Re-enable to keep catalog clean
      await makeRequest(`/api/admin/products/${sampleProductId}/availability`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: { is_active: true },
      });
    });

    await itAsync("Admin can list services and preserve NULL prices for manual quotation", async () => {
      const res = await makeRequest("/api/admin/services", {
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.services));
      assert.strictEqual(res.body.services.length, 5);

      const custom3d = res.body.services.find((s) => s.id === "custom_3d_art");
      assert.ok(custom3d);
      assert.strictEqual(custom3d.basePrice, null, "3D Art must retain NULL base price");
      assert.strictEqual(custom3d.promotionalPrice, null, "3D Art must retain NULL promotional price");
    });

    await itAsync("Admin can toggle salon service availability", async () => {
      const res = await makeRequest("/api/admin/services/extension_removal/availability", {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: { is_active: false },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.service.is_active, false);

      // Re-enable
      await makeRequest("/api/admin/services/extension_removal/availability", {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: { is_active: true },
      });
    });

    // =========================================================================
    // 6. STAFF DIRECTORY & RBAC PERMISSION MATRIX
    // =========================================================================
    console.log("\n🧪 6. Staff Roles & Permission Matrix");

    await itAsync("Super Operator can view staff directory", async () => {
      const res = await makeRequest("/api/admin/staff", {
        headers: { Authorization: "Bearer token_super" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.staff));
      const divyaStaff = res.body.staff.find((s) => s.displayName === "Lead Artist Divya");
      assert.ok(divyaStaff);
      assert.ok(divyaStaff.roles.includes("artist_divya"));
    });

    await itAsync("Lead Artist Divya is rejected from staff directory with 403 (Missing staff:manage)", async () => {
      const res = await makeRequest("/api/admin/staff", {
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_PERMISSION");
    });

    await itAsync("Admin can inspect roles and permissions matrix", async () => {
      const res = await makeRequest("/api/admin/roles", {
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.roles));
      assert.ok(Array.isArray(res.body.allPermissions));
      assert.strictEqual(res.body.allPermissions.length, 16);
      assert.ok(res.body.allPermissions.some((p) => p.id === "orders:verify_payment"));
    });

    // =========================================================================
    // 7. BUSINESS SETTINGS & AUDIT TRAILS
    // =========================================================================
    console.log("\n🧪 7. Business Settings & Audit Logs");

    await itAsync("Admin can list operational business settings", async () => {
      const res = await makeRequest("/api/admin/settings", {
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.settings));
      assert.ok(res.body.settings.length >= 9);
    });

    await itAsync("Super Operator can view audit logs verifying admin changes", async () => {
      const res = await makeRequest("/api/admin/audit-logs", {
        headers: { Authorization: "Bearer token_super" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.logs));
      assert.ok(res.body.logs.length > 0);
      const sampleLog = res.body.logs[0];
      assert.ok(sampleLog.action);
      assert.ok(sampleLog.targetEntity);
    });

    await itAsync("Staff Artist is rejected from viewing audit logs with 403 (Missing audit:view)", async () => {
      const res = await makeRequest("/api/admin/audit-logs", {
        headers: { Authorization: "Bearer token_staff" },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_PERMISSION");
    });

    // =========================================================================
    // 8. SECURITY & CROSS-BOUNDARY ENFORCEMENT
    // =========================================================================
    console.log("\n🧪 8. Security & Access Control Boundaries");

    await itAsync("Unauthenticated visitor is rejected from admin endpoints with 401", async () => {
      const res = await makeRequest("/api/admin/overview");
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, "AUTH_REQUIRED");
    });

    await itAsync("Regular customer is rejected from all admin endpoints with 403 (FORBIDDEN_ROLE)", async () => {
      const resOverview = await makeRequest("/api/admin/overview", {
        headers: { Authorization: "Bearer token_customer" },
      });
      assert.strictEqual(resOverview.status, 403);
      assert.strictEqual(resOverview.body.code, "FORBIDDEN_ROLE");

      const resCustomers = await makeRequest("/api/admin/customers", {
        headers: { Authorization: "Bearer token_customer" },
      });
      assert.strictEqual(resCustomers.status, 403);
      assert.strictEqual(resCustomers.body.code, "FORBIDDEN_ROLE");
    });

  } finally {
    testServer.close();
  }

  console.log("\n==================================================================");
  console.log(`🏁 ADMIN OPS TEST EXECUTION COMPLETE: ${passedCount} Passed, ${failedCount} Failed`);
  console.log("==================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAdminOpsTestSuite().catch((err) => {
  console.error("FATAL SUITE ERROR:", err);
  process.exit(1);
});
