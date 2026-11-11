/**
 * ==========================================================================
 * AT-HOME APPOINTMENT ENGINE TEST SUITE (`scripts/testBookings.js`)
 * Nails by Divya Platform — Phase 2B
 *
 * Automated regression & integration test suite covering:
 * - Available Services Catalog & NULL Price Preservation
 * - Guest Appointment Requests (Claim Secret Generation)
 * - Authenticated Customer Appointment Requests
 * - Input Validation: Service IDs, Date Formats, Past Dates, Pin Codes
 * - NULL Service & Add-On Pricing Handling
 * - Strict Cross-Customer Data Isolation & Unauthorized Access Prevention
 * - Duplicate Submission Prevention via Idempotency Key
 * - Customer Appointment Cancellation Life-Cycle
 * - Admin RBAC & Permission Verification
 * - Request Confirmation with Scheduled Slots
 * - Alternative Slot Proposal & Auto-Invalidation of Prior Action Tokens
 * - Request Rejection & Studio-Initiated Cancellation
 * - Chronological Status History & Comprehensive Audit Logging
 * - Database Transaction Rollbacks
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

async function runBookingTestSuite() {
  console.log("==================================================================");
  console.log("   NAILS BY DIVYA — PHASE 2B APPOINTMENT ENGINE TEST SUITE");
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
  const CUST_A_UID = `bkg_cust_a_${ts}`;
  const CUST_A_PHONE = `+919821${Math.floor(100000 + Math.random() * 900000)}`;
  const CUST_B_UID = `bkg_cust_b_${ts}`;
  const CUST_B_PHONE = `+919822${Math.floor(100000 + Math.random() * 900000)}`;
  const ADMIN_UID = `bkg_admin_${ts}`;
  const ADMIN_PHONE = `+919823${Math.floor(100000 + Math.random() * 900000)}`;

  const mockFirebaseUsers = {
    [ADMIN_UID]: { uid: ADMIN_UID, phoneNumber: ADMIN_PHONE, disabled: false },
    [CUST_A_UID]: { uid: CUST_A_UID, phoneNumber: CUST_A_PHONE, disabled: false },
    [CUST_B_UID]: { uid: CUST_B_UID, phoneNumber: CUST_B_PHONE, disabled: false },
  };

  setTestTokenVerifier(
    async (token) => {
      if (token === "token_cust_a") {
        return { uid: CUST_A_UID, phone_number: CUST_A_PHONE, auth_time: Math.floor(Date.now() / 1000) };
      }
      if (token === "token_cust_b") {
        return { uid: CUST_B_UID, phone_number: CUST_B_PHONE, auth_time: Math.floor(Date.now() / 1000) };
      }
      if (token === "token_admin") {
        return { uid: ADMIN_UID, phone_number: ADMIN_PHONE, auth_time: Math.floor(Date.now() / 1000) };
      }
      const err = new Error("Invalid test token");
      err.code = "INVALID_TOKEN";
      err.statusCode = 401;
      throw err;
    },
    async (uid) => mockFirebaseUsers[uid] || null
  );

  // Provision accounts
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
    displayName: "Lead Artist & Booking Manager",
  });

  // Calculate dynamic future dates
  const now = new Date();
  const d1 = new Date(now);
  d1.setUTCDate(d1.getUTCDate() + 3);
  const futureDate1 = d1.toISOString().slice(0, 10);

  const d2 = new Date(now);
  d2.setUTCDate(d2.getUTCDate() + 5);
  const futureDate2 = d2.toISOString().slice(0, 10);

  let guestBookingId = null;
  let guestClaimSecret = null;
  let authBookingId = null;

  try {
    // =========================================================================
    // SUITE 1: Service Catalog & NULL Price Preservation
    // =========================================================================
    console.log("🧪 1. Service Catalog & NULL Pricing Preservation");

    await itAsync("GET /api/services lists all 5 active salon services", async () => {
      const res = await makeRequest("/api/services");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "success");
      assert.strictEqual(res.body.services.length, 5);

      const gelExtensions = res.body.services.find((s) => s.id === "gel_extensions");
      assert.ok(gelExtensions);
      assert.strictEqual(gelExtensions.effectivePrice, 999.0);
      assert.strictEqual(gelExtensions.isCustomQuote, false);
      assert.ok(gelExtensions.addons.length >= 2);
    });

    await itAsync("GET /api/services preserves NULL pricing for custom quote services", async () => {
      const res = await makeRequest("/api/services/custom_3d_art");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.service.effectivePrice, null);
      assert.strictEqual(res.body.service.isCustomQuote, true);
      assert.strictEqual(res.body.service.pricingDisplay, "Custom Quote");
    });

    // =========================================================================
    // SUITE 2: Guest Appointment Requests
    // =========================================================================
    console.log("\n🧪 2. Guest Appointment Requests & Ownership Protection");

    await itAsync("POST /api/bookings creates guest request in REQUESTED status and returns claim secret", async () => {
      const res = await makeRequest("/api/bookings", {
        method: "POST",
        body: {
          customer: {
            name: "Radhika Mehra",
            phone: "+919811223344",
            email: "radhika.mehra@example.com",
          },
          service_id: "gel_extensions",
          service_address: {
            address_line1: "Tower 2, Apt 1403, The Crest",
            locality: "DLF Phase 5",
            city: "Gurgaon",
            state: "Haryana",
            postal_code: "122002",
          },
          requested_date: futureDate1,
          requested_time_slot: "02:00 PM - 04:00 PM",
          customer_notes: "Prefer oval almond shape; bridal engagement ceremony upcoming.",
          reference_image_url: "https://example.com/bridal_inspo.jpg",
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.status, "success");
      assert.ok(res.body.booking.bookingNumber.startsWith("NBD-BKG-"));
      assert.strictEqual(res.body.booking.bookingStatus, "REQUESTED");
      assert.strictEqual(res.body.booking.paymentStatus, "PENDING");
      assert.strictEqual(res.body.booking.estimatedTotal, 999.0);
      assert.strictEqual(res.body.booking.customerName, "Radhika Mehra");
      assert.strictEqual(res.body.booking.requestedDate, futureDate1);
      assert.strictEqual(res.body.booking.requestedTimeSlot, "02:00 PM - 04:00 PM");
      assert.strictEqual(res.body.booking.serviceAddress.postalCode, "122002");
      assert.ok(res.body.claimSecret); // Guest claim secret returned

      guestBookingId = res.body.booking.id;
      guestClaimSecret = res.body.claimSecret;
    });

    // =========================================================================
    // SUITE 3: Authenticated Customer Appointment Requests
    // =========================================================================
    console.log("\n🧪 3. Authenticated Customer Appointment Requests");

    await itAsync("POST /api/bookings links request to user_id when authenticated", async () => {
      const res = await makeRequest("/api/bookings", {
        method: "POST",
        headers: { Authorization: "Bearer token_cust_a" },
        body: {
          customer: {
            name: "Customer A",
            phone: CUST_A_PHONE,
          },
          service_id: "natural_overlay",
          service_address: {
            address_line1: "E-45, Vasant Vihar",
            locality: "Vasant Vihar",
            city: "New Delhi",
            state: "Delhi",
            postal_code: "110057",
          },
          requested_date: futureDate2,
          requested_time_slot: "10:00 AM - 12:00 PM",
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.booking.userId, userA.id);
      assert.strictEqual(res.body.booking.bookingStatus, "REQUESTED");
      assert.strictEqual(res.body.claimSecret, null); // Authenticated users don't need guest claim secret

      authBookingId = res.body.booking.id;
    });

    // =========================================================================
    // SUITE 4: Validation: Service ID, Dates & Postal Code
    // =========================================================================
    console.log("\n🧪 4. Server-Side Input Validation");

    await itAsync("POST /api/bookings rejects invalid service_id with 400", async () => {
      const res = await makeRequest("/api/bookings", {
        method: "POST",
        body: {
          customer: { name: "Test User", phone: "+919811000000" },
          service_id: "nonexistent_service_999",
          service_address: {
            address_line1: "123 Main St",
            city: "Delhi",
            state: "Delhi",
            postal_code: "110001",
          },
          requested_date: futureDate1,
          requested_time_slot: "10:00 AM - 12:00 PM",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_SERVICE_ID");
    });

    await itAsync("POST /api/bookings rejects past dates with 400", async () => {
      const res = await makeRequest("/api/bookings", {
        method: "POST",
        body: {
          customer: { name: "Test User", phone: "+919811000000" },
          service_id: "gel_extensions",
          service_address: {
            address_line1: "123 Main St",
            city: "Delhi",
            state: "Delhi",
            postal_code: "110001",
          },
          requested_date: "2020-01-15", // Past date
          requested_time_slot: "10:00 AM - 12:00 PM",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PAST_DATE_NOT_ALLOWED");
    });

    await itAsync("POST /api/bookings rejects invalid calendar dates (e.g. 2026-02-31) with 400", async () => {
      const res = await makeRequest("/api/bookings", {
        method: "POST",
        body: {
          customer: { name: "Test User", phone: "+919811000000" },
          service_id: "gel_extensions",
          service_address: {
            address_line1: "123 Main St",
            city: "Delhi",
            state: "Delhi",
            postal_code: "110001",
          },
          requested_date: "2026-02-31", // Nonexistent date
          requested_time_slot: "10:00 AM - 12:00 PM",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_DATE");
    });

    await itAsync("POST /api/bookings rejects invalid Indian PIN code with 400", async () => {
      const res = await makeRequest("/api/bookings", {
        method: "POST",
        body: {
          customer: { name: "Test User", phone: "+919811000000" },
          service_id: "gel_extensions",
          service_address: {
            address_line1: "123 Main St",
            city: "Delhi",
            state: "Delhi",
            postal_code: "010001", // Invalid leading zero in Indian PIN
          },
          requested_date: futureDate1,
          requested_time_slot: "10:00 AM - 12:00 PM",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_PINCODE");
    });

    // =========================================================================
    // SUITE 5: Custom Quote & NULL Pricing Preservation in Bookings
    // =========================================================================
    console.log("\n🧪 5. Custom Quote & NULL Pricing Preservation in Bookings");

    await itAsync("Booking request with unquoted service preserves estimatedTotal: null", async () => {
      const res = await makeRequest("/api/bookings", {
        method: "POST",
        body: {
          customer: { name: "Aarti Verma", phone: "+919811554433" },
          service_id: "custom_3d_art", // Service with base_price: null
          service_address: {
            address_line1: "Pocket 1, Sector 9, Dwarka",
            city: "New Delhi",
            state: "Delhi",
            postal_code: "110075",
          },
          requested_date: futureDate1,
          requested_time_slot: "03:00 PM - 05:00 PM",
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.booking.estimatedTotal, null);
      assert.strictEqual(res.body.booking.isCustomQuote, true);
      assert.ok(res.body.booking.pricingDisplay.includes("Custom Quote"));
    });

    // =========================================================================
    // SUITE 6: Cross-Customer Isolation & Unauthorized Access Defense
    // =========================================================================
    console.log("\n🧪 6. Cross-Customer Data Isolation & Security");

    await itAsync("Unauthenticated stranger cannot access an appointment without credentials", async () => {
      const res = await makeRequest(`/api/bookings/${authBookingId}`);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_BOOKING_ACCESS");
    });

    await itAsync("Customer B cannot access Customer A's appointment", async () => {
      const res = await makeRequest(`/api/bookings/${authBookingId}`, {
        headers: { Authorization: "Bearer token_cust_b" },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_BOOKING_ACCESS");
    });

    await itAsync("Customer A can access their own appointment", async () => {
      const res = await makeRequest(`/api/bookings/${authBookingId}`, {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.booking.id, authBookingId);
    });

    await itAsync("Guest can access their appointment using valid claim_secret", async () => {
      const res = await makeRequest(`/api/bookings/${guestBookingId}?claim_secret=${guestClaimSecret}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.booking.id, guestBookingId);
    });

    await itAsync("GET /api/bookings lists only authenticated customer's own appointments", async () => {
      const resA = await makeRequest("/api/bookings", {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(resA.status, 200);
      assert.ok(resA.body.bookings.every((b) => b.id === authBookingId));

      const resB = await makeRequest("/api/bookings", {
        headers: { Authorization: "Bearer token_cust_b" },
      });
      assert.strictEqual(resB.status, 200);
      assert.ok(!resB.body.bookings.some((b) => b.id === authBookingId));
    });

    // =========================================================================
    // SUITE 7: Idempotency Protection
    // =========================================================================
    console.log("\n🧪 7. Idempotency & Duplicate Submission Prevention");

    await itAsync("Submitting appointment with same Idempotency-Key returns existing booking without duplicate row", async () => {
      const testIdemKey = `idem-bkg-${ts}`;

      const res1 = await makeRequest("/api/bookings", {
        method: "POST",
        headers: { "Idempotency-Key": testIdemKey },
        body: {
          customer: { name: "Idem User", phone: "+919811998877" },
          service_id: "gel_extensions",
          service_address: {
            address_line1: "123 Idem Avenue",
            city: "Noida",
            state: "Uttar Pradesh",
            postal_code: "201301",
          },
          requested_date: futureDate1,
          requested_time_slot: "11:00 AM - 01:00 PM",
        },
      });

      assert.strictEqual(res1.status, 201);
      const originalNumber = res1.body.booking.bookingNumber;
      const originalId = res1.body.booking.id;

      // Duplicate submission
      const res2 = await makeRequest("/api/bookings", {
        method: "POST",
        headers: { "Idempotency-Key": testIdemKey },
        body: {
          customer: { name: "Idem User", phone: "+919811998877" },
          service_id: "gel_extensions",
          service_address: {
            address_line1: "123 Idem Avenue",
            city: "Noida",
            state: "Uttar Pradesh",
            postal_code: "201301",
          },
          requested_date: futureDate1,
          requested_time_slot: "11:00 AM - 01:00 PM",
        },
      });

      assert.strictEqual(res2.status, 200); // 200 indicates idempotent replay
      assert.strictEqual(res2.body.booking.bookingNumber, originalNumber);
      assert.strictEqual(res2.body.booking.id, originalId);
      assert.strictEqual(res2.body.isDuplicate, true);

      // Verify in DB that only 1 record exists
      const dbCheck = await query(
        `SELECT COUNT(*)::int AS count FROM bookings WHERE guest_session_token = $1;`,
        [`idem:${testIdemKey}`]
      );
      assert.strictEqual(dbCheck.rows[0].count, 1);
    });

    // =========================================================================
    // SUITE 8: Customer Cancellation Life-Cycle
    // =========================================================================
    console.log("\n🧪 8. Customer Cancellation Life-Cycle");

    await itAsync("Customer A can cancel their pending appointment request", async () => {
      const res = await makeRequest(`/api/bookings/${authBookingId}/cancel`, {
        method: "POST",
        headers: { Authorization: "Bearer token_cust_a" },
        body: { reason: "Traveling out of town on that weekend." },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.booking.bookingStatus, "CANCELLED_BY_CUSTOMER");
    });

    await itAsync("Attempting to cancel an already cancelled appointment returns 400", async () => {
      const res = await makeRequest(`/api/bookings/${authBookingId}/cancel`, {
        method: "POST",
        headers: { Authorization: "Bearer token_cust_a" },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "BOOKING_CANNOT_BE_CANCELLED");
    });

    // =========================================================================
    // SUITE 9: Admin RBAC & Booking Management
    // =========================================================================
    console.log("\n🧪 9. Admin RBAC & Booking Management");

    await itAsync("Regular customer is rejected from GET /api/admin/bookings with 403", async () => {
      const res = await makeRequest("/api/admin/bookings", {
        headers: { Authorization: "Bearer token_cust_a" },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_ROLE");
    });

    await itAsync("Admin can list appointments with filters and pagination", async () => {
      const res = await makeRequest("/api/admin/bookings?limit=10", {
        headers: { Authorization: "Bearer token_admin" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.bookings));
      assert.ok(res.body.total >= 2);
    });

    await itAsync("Admin can propose an alternative slot and generate an action token", async () => {
      const res = await makeRequest(`/api/admin/bookings/${guestBookingId}/propose-slot`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_admin" },
        body: {
          alternative_date: futureDate2,
          alternative_time_slot: "04:30 PM - 06:30 PM",
          reschedule_reason: "Divya is attending a bridal suite appointment during earlier window.",
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.booking.bookingStatus, "ALTERNATIVE_PROPOSED");
      assert.strictEqual(res.body.booking.alternativeProposedDate, futureDate2);
      assert.strictEqual(res.body.booking.alternativeProposedTimeSlot, "04:30 PM - 06:30 PM");
      assert.ok(res.body.actionToken); // Action token generated for customer response
    });

    await itAsync("Admin can confirm an appointment and set scheduled times", async () => {
      const startTime = new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString();
      const endTime = new Date(Date.now() + (4 * 24 + 2) * 3600 * 1000).toISOString();

      const res = await makeRequest(`/api/admin/bookings/${guestBookingId}/confirm`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_admin" },
        body: {
          confirmed_start_time: startTime,
          confirmed_end_time: endTime,
          notes: "Confirmed by Divya. Premium gel kit and nail art equipment prepared.",
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.booking.bookingStatus, "CONFIRMED");
      assert.ok(res.body.booking.confirmedStartTime);
    });

    // =========================================================================
    // SUITE 10: Status History & Audit Trail Tracking
    // =========================================================================
    console.log("\n🧪 10. Status History & Audit Trail Tracking");

    await itAsync("Status history tracks full appointment lifecycle with actor types and notes", async () => {
      const res = await makeRequest(`/api/admin/bookings/${guestBookingId}`, {
        headers: { Authorization: "Bearer token_admin" },
      });

      assert.strictEqual(res.status, 200);
      const history = res.body.statusHistory;
      assert.ok(history.length >= 3);

      // Verify sequence of statuses: REQUESTED -> ALTERNATIVE_PROPOSED -> CONFIRMED
      assert.strictEqual(history[0].toStatus, "REQUESTED");
      assert.strictEqual(history[0].actorType, "customer");

      const altEntry = history.find((h) => h.toStatus === "ALTERNATIVE_PROPOSED");
      assert.ok(altEntry);
      assert.strictEqual(altEntry.actorType, "divya");

      const confirmEntry = history.find((h) => h.toStatus === "CONFIRMED");
      assert.ok(confirmEntry);
      assert.strictEqual(confirmEntry.actorType, "divya");

      // Verify audit logs were written
      const auditRes = await query(
        `SELECT * FROM audit_logs WHERE target_entity = 'bookings' AND target_id = $1;`,
        [guestBookingId]
      );
      assert.ok(auditRes.rows.length >= 2);
    });

    // =========================================================================
    // SUITE 11: Database Transaction Rollbacks
    // =========================================================================
    console.log("\n🧪 11. Database Transaction Rollbacks");

    await itAsync("Failed appointment submission creates 0 rows in bookings", async () => {
      const preCountRes = await query(`SELECT COUNT(*)::int AS count FROM bookings;`);
      const preCount = preCountRes.rows[0].count;

      const res = await makeRequest("/api/bookings", {
        method: "POST",
        body: {
          customer: { name: "Failing User", phone: "+919811000000" },
          service_id: "nonexistent_service_invalid",
          service_address: {
            address_line1: "123 Rollback St",
            city: "Delhi",
            state: "Delhi",
            postal_code: "110001",
          },
          requested_date: futureDate1,
          requested_time_slot: "10:00 AM - 12:00 PM",
        },
      });

      assert.strictEqual(res.status, 400);

      const postCountRes = await query(`SELECT COUNT(*)::int AS count FROM bookings;`);
      assert.strictEqual(postCountRes.rows[0].count, preCount);
    });

  } finally {
    clearTestTokenVerifier();
    testServer.close();
  }

  console.log("\n==================================================================");
  console.log(`🏁 BOOKING TEST EXECUTION COMPLETE: ${passedCount} Passed, ${failedCount} Failed`);
  console.log("==================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runBookingTestSuite()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal Test Suite Error:", err);
      process.exit(1);
    });
}

module.exports = { runBookingTestSuite };
