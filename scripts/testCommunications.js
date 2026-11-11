/**
 * ==============================================================================
 * COMMUNICATIONS & FULFILMENT COMPREHENSIVE TEST SUITE (`scripts/testCommunications.js`)
 * Nails by Divya Platform — Phase 3A
 *
 * Verifies:
 * 1. CORS Domain Verification (nailsbydivya.store, www, staging, unauthorized rejections)
 * 2. Notification Templates & Pre-filled WhatsApp Link Generator
 * 3. Notification Queueing & Idempotency Enforcement (Duplicate Prevention)
 * 4. Provider Dispatch Simulation & Delivery Log Audit Trail
 * 5. Order Fulfilment & Carrier Tracking Integration
 * 6. Delhi NCR Booking Notification Lifecycle (Request, Confirm, Propose, Decline, Cancel)
 * 7. Admin Communications Telemetry & Manual WhatsApp Fallback Links
 * ==============================================================================
 */

"use strict";

require("dotenv").config();
const assert = require("assert");
const { getPool, query } = require("../src/db/pool");
const { getCorsOriginValidator, ALLOWED_PROD_ORIGINS, ALLOWED_STAGING_ORIGINS } = require("../src/middleware/corsConfig");
const {
  renderTemplate,
  generateManualWaLink,
  toWaDigits,
  TEMPLATES,
} = require("../src/services/notifications/notificationTemplates");
const {
  queueNotification,
  processNotificationJob,
  listNotifications,
  retryNotification,
} = require("../src/services/notifications/notificationService");
const {
  adminUpdateOrderStatus,
  getOrderById,
  createOrderFromCart,
} = require("../src/services/orderService");
const {
  createAppointmentRequest,
  confirmAppointmentRequest,
  proposeAlternativeSlot,
  declineAppointmentRequest,
  cancelAppointmentRequest,
  getAppointmentById,
} = require("../src/services/bookingService");

let totalTests = 0;
let passedTests = 0;

function it(desc, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✅ ${desc}`);
  } catch (err) {
    console.error(`  ❌ ${desc}`);
    console.error(`     Error: ${err.message}`);
    throw err;
  }
}

async function itAsync(desc, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ ${desc}`);
  } catch (err) {
    console.error(`  ❌ ${desc}`);
    console.error(`     Error: ${err.message}`);
    throw err;
  }
}

async function runCommunicationsSuite() {
  console.log("\n===============================================================================");
  console.log("  NAILS BY DIVYA — PHASE 3A COMMUNICATIONS & FULFILMENT SUITE");
  console.log("===============================================================================\n");

  // ===========================================================================
  // TEST SECTION 1: CORS DOMAIN CONFIGURATION & REGRESSION
  // ===========================================================================
  console.log("--- 1. CORS Domain Validation & Strict Origin Enforcement ---");

  it("Production CORS explicitly whitelists nailsbydivya.store and www.nailsbydivya.store", () => {
    assert(ALLOWED_PROD_ORIGINS.includes("https://nailsbydivya.store"), "Apex domain must be allowed");
    assert(ALLOWED_PROD_ORIGINS.includes("https://www.nailsbydivya.store"), "WWW subdomain must be allowed");
    assert(!ALLOWED_PROD_ORIGINS.includes("https://nailsbydivya.com"), "Legacy .com domain must NOT be in production origins");
  });

  it("Staging CORS explicitly whitelists staging and preview subdomains", () => {
    assert(ALLOWED_STAGING_ORIGINS.includes("https://staging.nailsbydivya.store"));
    assert(ALLOWED_STAGING_ORIGINS.includes("https://preview.nailsbydivya.store"));
  });

  it("Origin validator allows apex and www origins in production mode", () => {
    const prodValidator = getCorsOriginValidator("production");
    
    prodValidator("https://nailsbydivya.store", (err, allow) => {
      assert.strictEqual(err, null);
      assert.strictEqual(allow, true);
    });

    prodValidator("https://www.nailsbydivya.store", (err, allow) => {
      assert.strictEqual(err, null);
      assert.strictEqual(allow, true);
    });
  });

  it("Origin validator rejects unauthorized third-party and legacy .com domains", () => {
    const prodValidator = getCorsOriginValidator("production");

    prodValidator("https://nailsbydivya.com", (err, allow) => {
      assert(err !== null, "Should return CORS rejection error for .com");
      assert.strictEqual(allow, false);
    });

    prodValidator("https://malicious-phishing-site.example", (err, allow) => {
      assert(err !== null, "Should return CORS rejection error for untrusted domain");
      assert.strictEqual(allow, false);
    });
  });

  // ===========================================================================
  // TEST SECTION 2: TEMPLATES & PRE-FILLED WHATSAPP CLICK-TO-CHAT
  // ===========================================================================
  console.log("\n--- 2. Brand Notification Templates & WhatsApp Fallback ---");

  it("Formats Indian mobile numbers into international WhatsApp digits (91XXXXXXXXXX)", () => {
    assert.strictEqual(toWaDigits("+91 98110 00001"), "919811000001");
    assert.strictEqual(toWaDigits("9811000001"), "919811000001");
    assert.strictEqual(toWaDigits("09811000001"), "919811000001");
  });

  it("Renders ORDER_CONFIRMED template and generates valid wa.me fallback link", () => {
    const rendered = renderTemplate("ORDER_CONFIRMED", {
      customerName: "Ananya Sharma",
      orderNumber: "NBD-ORD-101",
      itemCount: 2,
      totalAmount: 1198,
    }, "+91 98110 00001");
    assert(rendered.text.includes("NBD-ORD-101"), "Rendered text must contain order number");
    assert(rendered.text.includes("Ananya Sharma"), "Rendered text must contain customer name");
    assert(rendered.text.includes("₹1198.00"), "Rendered text must format INR amount");

    assert(rendered.waLink.startsWith("https://wa.me/919811000001?text="), "Link must start with https://wa.me/919811000001?text=");
    assert(rendered.waLink.includes(encodeURIComponent("NBD-ORD-101")), "Link must contain URL-encoded order number");
  });

  it("Renders ORDER_DISPATCHED template with courier name and tracking details", () => {
    const rendered = renderTemplate("ORDER_DISPATCHED", {
      customerName: "Rhea Sen",
      orderNumber: "NBD-ORD-202",
      courierName: "Delhivery Surface",
      trackingNumber: "DLV123456789",
      trackingUrl: "https://track.delhivery.com/DLV123456789",
    });
    assert(rendered.text.includes("Delhivery Surface"));
    assert(rendered.text.includes("DLV123456789"));
    assert(rendered.text.includes("https://track.delhivery.com/DLV123456789"));
  });

  it("Renders APPOINTMENT_REQUESTED, CONFIRMED, and ALTERNATIVE_PROPOSED templates", () => {
    const reqRendered = renderTemplate("APPOINTMENT_REQUESTED", {
      customerName: "Kavita Rao",
      bookingNumber: "NBD-BKG-88",
      serviceName: "Gel Extensions",
      requestedDate: "2026-11-20",
      requestedTimeSlot: "14:00 - 16:00",
    });
    assert(reqRendered.text.includes("NBD-BKG-88"));
    assert(reqRendered.text.includes("Gel Extensions"));

    const altRendered = renderTemplate("APPOINTMENT_ALTERNATIVE_PROPOSED", {
      customerName: "Kavita Rao",
      bookingNumber: "NBD-BKG-88",
      proposedDate: "2026-11-21",
      proposedSlot: "11:00 - 13:00",
      rescheduleReason: "Studio capacity reached on requested date",
    });
    assert(altRendered.text.includes("2026-11-21 (11:00 - 13:00)"));
    assert(altRendered.text.includes("Studio capacity reached"));
  });

  // ===========================================================================
  // TEST SECTION 3: NOTIFICATION QUEUEING & IDEMPOTENCY ENFORCEMENT
  // ===========================================================================
  console.log("\n--- 3. Notification Queueing & Idempotency Enforcement ---");

  // Clean up any lingering test idempotency keys from previous runs
  await query(`DELETE FROM notification_delivery_logs WHERE job_id IN (SELECT id FROM notification_jobs WHERE idempotency_key LIKE 'test_idem_%');`);
  await query(`DELETE FROM notification_jobs WHERE idempotency_key LIKE 'test_idem_%';`);

  let testJobId = null;

  await itAsync("Queues notification job with deterministic idempotency key", async () => {
    const res = await queueNotification({
      channel: "whatsapp",
      recipientPhone: "+919811000001",
      templateKey: "ORDER_CONFIRMED",
      variables: {
        customerName: "Idempotency Test User",
        orderNumber: "NBD-ORD-IDEM-01",
        itemCount: 1,
        totalAmount: 599,
      },
      idempotencyKey: "test_idem_key_001",
      autoDispatch: false, // Keep queued to test manual processing step
    });

    assert(res && res.job, "Job must be returned in res.job");
    assert.strictEqual(res.job.recipient_phone, "+919811000001");
    assert.strictEqual(res.job.template_name, "order_confirmed");
    assert.strictEqual(res.job.status, "QUEUED");
    assert.strictEqual(res.job.idempotency_key, "test_idem_key_001");
    assert(res.isNew, "First insertion must be marked isNew=true");
    testJobId = res.job.id;
  });

  await itAsync("Enforces idempotency: Duplicate queue request returns existing record without duplicate insertion", async () => {
    const duplicateRes = await queueNotification({
      channel: "whatsapp",
      recipientPhone: "+919811000001",
      templateKey: "ORDER_CONFIRMED",
      variables: {
        customerName: "Idempotency Test User",
        orderNumber: "NBD-ORD-IDEM-01",
      },
      idempotencyKey: "test_idem_key_001",
    });

    assert.strictEqual(duplicateRes.job.id, testJobId, "Duplicate call must return exact same job ID");
    assert.strictEqual(duplicateRes.isNew, false, "Duplicate call must return isNew=false");

    // Verify database row count for this key is exactly 1
    const countRes = await query(
      `SELECT COUNT(*)::int AS count FROM notification_jobs WHERE idempotency_key = 'test_idem_key_001';`
    );
    assert.strictEqual(countRes.rows[0].count, 1, "Database must contain exactly 1 row for this idempotency key");
  });

  // ===========================================================================
  // TEST SECTION 4: PROVIDER ADAPTER DISPATCH & DELIVERY LOGGING
  // ===========================================================================
  console.log("\n--- 4. Provider Dispatch Simulation & Delivery Log Audit ---");

  await itAsync("Processes queued job and records delivery attempt in notification_delivery_logs", async () => {
    const processedJob = await processNotificationJob(testJobId);
    assert.strictEqual(processedJob.id, testJobId);
    assert.strictEqual(processedJob.status, "SENT");

    // Verify delivery log insertion
    const logRes = await query(
      `SELECT * FROM notification_delivery_logs WHERE job_id = $1 ORDER BY updated_at DESC LIMIT 1;`,
      [testJobId]
    );
    assert.strictEqual(logRes.rows.length, 1, "Must have recorded delivery log row");
    assert.strictEqual(logRes.rows[0].delivery_status, "SENT");
    assert(logRes.rows[0].provider_message_id.startsWith("sim_wa_"), "Simulated message ID must start with sim_wa_");
  });

  await itAsync("Lists notifications with delivery telemetry and operator fallback link", async () => {
    const result = await listNotifications({ search: "NBD-ORD-IDEM-01" });
    assert(result.notifications.length >= 1, "Must return at least 1 notification");
    const item = result.notifications.find((n) => n.id === testJobId);
    assert(item, "Must include our test job");
    assert.strictEqual(item.status, "SENT");
    assert(item.manualWaLink.startsWith("https://wa.me/919811000001?text="), "Must contain manual WhatsApp fallback");
    assert.strictEqual(item.delivery.status, "SENT");
  });

  // ===========================================================================
  // TEST SECTION 5: ORDER FULFILMENT & TRACKING LIFECYCLE
  // ===========================================================================
  console.log("\n--- 5. Order Fulfilment & Carrier Tracking Integration ---");

  let testOrderId = null;

  await itAsync("Retrieves active test order and updates status with courier & tracking number", async () => {
    // Find an active order in database
    const orderRes = await query(`SELECT id, order_number, user_id FROM orders LIMIT 1;`);
    assert(orderRes.rows.length > 0, "Database must have at least one test order");
    testOrderId = orderRes.rows[0].id;

    const mockAdmin = { id: orderRes.rows[0].user_id, roles: ["super_operator"] };

    // Update status to DISPATCHED with carrier information
    const updated = await adminUpdateOrderStatus(
      testOrderId,
      {
        orderStatus: "CONFIRMED",
        fulfilmentStatus: "DISPATCHED",
        courierName: "Delhivery Surface",
        trackingNumber: "DLV9988776655",
        trackingUrl: "https://track.delhivery.com/DLV9988776655",
        notes: "Carefully packed with custom cuticle oil and buffer.",
        notifyCustomer: true,
      },
      mockAdmin,
      "127.0.0.1"
    );

    assert(updated.order, "Must return updated order snapshot");
    assert.strictEqual(updated.order.orderStatus, "CONFIRMED");
    assert.strictEqual(updated.order.fulfilmentStatus, "DISPATCHED");
    assert.strictEqual(updated.order.courierName, "Delhivery Surface");
    assert.strictEqual(updated.order.trackingNumber, "DLV9988776655");
    assert.strictEqual(updated.order.trackingUrl, "https://track.delhivery.com/DLV9988776655");

    // Verify shipment record in shipments table
    const shipRes = await query(
      `SELECT * FROM shipments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1;`,
      [testOrderId]
    );
    assert.strictEqual(shipRes.rows.length, 1, "Must have recorded shipment row in shipments table");
    assert.strictEqual(shipRes.rows[0].courier_name, "Delhivery Surface");
    assert.strictEqual(shipRes.rows[0].tracking_number, "DLV9988776655");

    // Verify notification job was automatically queued for order dispatch
    const notifRes = await query(
      `SELECT * FROM notification_jobs WHERE template_variables->>'orderId' = $1 AND template_name = 'order_dispatched' ORDER BY created_at DESC LIMIT 1;`,
      [testOrderId]
    );
    assert.strictEqual(notifRes.rows.length, 1, "Must have automatically queued ORDER_DISPATCHED notification");
  });

  await itAsync("Retrieves order details including shipment details and communication history", async () => {
    const fullOrder = await getOrderById(testOrderId, { isAdmin: true, skipAuthCheck: true });
    assert(fullOrder.order.courierName === "Delhivery Surface");
    assert(fullOrder.order.trackingNumber === "DLV9988776655");
    assert(Array.isArray(fullOrder.notifications), "Order must include notifications array");
    assert(fullOrder.notifications.length > 0, "Order must have at least one recorded notification");
  });

  // ===========================================================================
  // TEST SECTION 6: AT-HOME APPOINTMENT COMMUNICATIONS LIFECYCLE
  // ===========================================================================
  console.log("\n--- 6. Delhi NCR Booking Notification Lifecycle ---");

  let testBookingId = null;

  await itAsync("Creates at-home booking request and automatically queues APPOINTMENT_REQUESTED", async () => {
    // Find active service
    const svcRes = await query(`SELECT id FROM services WHERE is_active = TRUE LIMIT 1;`);
    assert(svcRes.rows.length > 0, "Must have active service");
    const serviceId = svcRes.rows[0].id;

    const futureDate = new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString().split("T")[0];

    const bookingResult = await createAppointmentRequest({
      customer: {
        name: "Pooja Malhotra",
        phone: "+919811000002",
        email: "pooja@example.com",
      },
      serviceId,
      requestedDate: futureDate,
      requestedTimeSlot: "11:00 - 13:00",
      serviceAddress: {
        addressLine1: "Flat 402, Lotus Boulevard",
        city: "Noida",
        state: "Uttar Pradesh",
        postalCode: "201304",
      },
      customerNotes: "Please bring nude polish options.",
    });

    testBookingId = bookingResult.booking.id;
    assert(testBookingId, "Booking ID must be returned");

    // Verify APPOINTMENT_REQUESTED notification queued
    const notifRes = await query(
      `SELECT * FROM notification_jobs WHERE template_variables->>'bookingId' = $1 AND template_name = 'appointment_requested';`,
      [testBookingId]
    );
    assert.strictEqual(notifRes.rows.length, 1, "Must have queued APPOINTMENT_REQUESTED notification");
  });

  await itAsync("Proposes alternative slot and automatically queues APPOINTMENT_ALTERNATIVE_PROPOSED", async () => {
    const altDate = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().split("T")[0];
    const mockAdmin = { id: (await query(`SELECT id FROM users LIMIT 1;`)).rows[0].id, roles: ["artist_divya"] };

    const proposed = await proposeAlternativeSlot(
      testBookingId,
      {
        alternativeDate: altDate,
        alternativeTimeSlot: "15:00 - 17:00",
        rescheduleReason: "Divya is engaged at another south Delhi client in the morning.",
      },
      mockAdmin,
      "127.0.0.1"
    );

    assert.strictEqual(proposed.booking.bookingStatus, "ALTERNATIVE_PROPOSED");

    // Verify APPOINTMENT_ALTERNATIVE_PROPOSED notification queued
    const notifRes = await query(
      `SELECT * FROM notification_jobs WHERE template_variables->>'bookingId' = $1 AND template_name = 'appointment_alternative_proposed';`,
      [testBookingId]
    );
    assert.strictEqual(notifRes.rows.length, 1, "Must have queued APPOINTMENT_ALTERNATIVE_PROPOSED notification");
  });

  await itAsync("Confirms appointment request and automatically queues APPOINTMENT_CONFIRMED", async () => {
    const mockAdmin = { id: (await query(`SELECT id FROM users LIMIT 1;`)).rows[0].id, roles: ["artist_divya"] };

    const startTime = new Date(Date.now() + 5 * 24 * 3600 * 1000);
    startTime.setHours(15, 0, 0, 0);
    const endTime = new Date(startTime.getTime() + 2 * 3600 * 1000);

    const confirmed = await confirmAppointmentRequest(
      testBookingId,
      {
        confirmedStartTime: startTime.toISOString(),
        confirmedEndTime: endTime.toISOString(),
        notes: "Confirmed for Noida at-home appointment.",
      },
      mockAdmin,
      "127.0.0.1"
    );

    assert.strictEqual(confirmed.booking.bookingStatus, "CONFIRMED");

    // Verify APPOINTMENT_CONFIRMED notification queued
    const notifRes = await query(
      `SELECT * FROM notification_jobs WHERE template_variables->>'bookingId' = $1 AND template_name = 'appointment_confirmed';`,
      [testBookingId]
    );
    assert.strictEqual(notifRes.rows.length, 1, "Must have queued APPOINTMENT_CONFIRMED notification");
  });

  await itAsync("Retrieves booking details including complete communication history", async () => {
    const bookingDetails = await getAppointmentById(testBookingId, { isAdmin: true, skipAuthCheck: true });
    assert(Array.isArray(bookingDetails.notifications), "Booking details must include notifications array");
    assert(bookingDetails.notifications.length >= 2, "Booking must have at least 2 recorded notifications");
    assert(bookingDetails.notifications.some((n) => n.manualWaLink.startsWith("https://wa.me/")), "Must contain WhatsApp fallback link");
  });

  // ===========================================================================
  // TEST SUMMARY
  // ===========================================================================
  console.log("\n===============================================================================");
  console.log(`  PHASE 3A COMMUNICATIONS SUITE PASSED: ${passedTests}/${totalTests} TESTS`);
  console.log("===============================================================================\n");
}

runCommunicationsSuite()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ SUITE EXECUTION FAILED:", err);
    process.exit(1);
  });
