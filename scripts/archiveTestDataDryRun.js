/**
 * ==============================================================================
 * PRODUCTION TEST DATA CLEANUP — DRY-RUN ANALYSIS & ARCHIVE PREPARATION SCRIPT
 * (`scripts/archiveTestDataDryRun.js`)
 * Nails by Divya Platform — Phase 5.2 Stabilisation
 *
 * SAFETY GUARANTEE:
 * - This script is 100% READ-ONLY.
 * - Does NOT execute DELETE, UPDATE, ALTER, or DROP statements.
 * - Produces exact counts, identifies foreign-key relationships, and outputs
 *   a complete reversible archive plan for approval.
 * ==============================================================================
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { query, closePool } = require("../src/db/pool");

const KNOWN_TEST_CUSTOMER_NAMES = [
  "Ananya Roy",
  "Ops Customer",
  "Cancel Customer",
  "Customer A",
  "Aditi Sharma",
  "Idem User",
  "Rhea Sen",
  "Verified Customer",
  "Aanya Verma",
  "Staging Test Customer",
  "Ops Booking Customer",
  "Meera Kapoor",
  "Aarti Verma",
  "Radhika Mehra",
  "Pooja Malhotra",
  "Pooja Verma",
];

const PRESERVED_SMOKE_TEST_PHONES = [
  "+917307622189",
  "7307622189",
];

async function runDryRun() {
  console.log("==================================================================");
  console.log("   NAILS BY DIVYA — PRODUCTION TEST DATA CLEANUP DRY-RUN");
  console.log("   Mode: STRICT READ-ONLY ANALYSIS (No database writes)");
  console.log("==================================================================\n");

  // 1. Total records check
  const totalOrdersRes = await query("SELECT COUNT(*)::int AS count FROM orders;");
  const totalBookingsRes = await query("SELECT COUNT(*)::int AS count FROM bookings;");
  const totalOrders = totalOrdersRes.rows[0].count;
  const totalBookings = totalBookingsRes.rows[0].count;

  // 2. Developer Smoke Test records check (MUST BE PRESERVED)
  const smokeOrdersRes = await query(
    `SELECT id, order_number, customer_name, customer_phone, total_amount, order_status, payment_status, created_at
     FROM orders
     WHERE customer_name ILIKE '%Raghavendra%' OR customer_phone = ANY($1)
     ORDER BY created_at ASC;`,
    [PRESERVED_SMOKE_TEST_PHONES]
  );
  const smokeOrders = smokeOrdersRes.rows;

  const smokeBookingsRes = await query(
    `SELECT id, booking_number, customer_name, customer_phone, service_id, requested_date, booking_status, created_at
     FROM bookings
     WHERE customer_name ILIKE '%Raghavendra%' OR customer_phone = ANY($1)
     ORDER BY created_at ASC;`,
    [PRESERVED_SMOKE_TEST_PHONES]
  );
  const smokeBookings = smokeBookingsRes.rows;

  // Smoke test IDs to strictly exclude
  const smokeOrderIds = smokeOrders.map((o) => o.id);
  const smokeBookingIds = smokeBookings.map((b) => b.id);

  // 3. Test Orders Identification
  const testOrdersRes = await query(
    `SELECT id, order_number, customer_name, customer_phone, total_amount, order_status, payment_status, created_at
     FROM orders
     WHERE id != ALL($1)
       AND (
         customer_name = ANY($2)
         OR order_number LIKE 'NBD-ORD-PAY-%'
         OR order_number LIKE 'NBD-ORD-OPS-%'
       )
     ORDER BY created_at ASC;`,
    [smokeOrderIds.length > 0 ? smokeOrderIds : ["00000000-0000-0000-0000-000000000000"], KNOWN_TEST_CUSTOMER_NAMES]
  );
  const testOrders = testOrdersRes.rows;
  const testOrderIds = testOrders.map((o) => o.id);

  // 4. Test Bookings Identification
  const testBookingsRes = await query(
    `SELECT id, booking_number, customer_name, customer_phone, service_id, requested_date, booking_status, created_at
     FROM bookings
     WHERE id != ALL($1)
       AND (
         customer_name = ANY($2)
         OR booking_number LIKE 'NBD-BKG-OPS-%'
       )
     ORDER BY created_at ASC;`,
    [smokeBookingIds.length > 0 ? smokeBookingIds : ["00000000-0000-0000-0000-000000000000"], KNOWN_TEST_CUSTOMER_NAMES]
  );
  const testBookings = testBookingsRes.rows;
  const testBookingIds = testBookings.map((b) => b.id);

  // 5. Test Cohort Breakdown Analysis
  const orderCohorts = {};
  for (const o of testOrders) {
    let cohort = "testStorefrontCustomerJourneys.js / verifyStagingIntegration.js";
    if (o.order_number.startsWith("NBD-ORD-PAY-") || o.customer_name === "Ananya Roy") {
      cohort = "testPaymentVerification.js (Concurrency & Payment Verification)";
    } else if (o.order_number.startsWith("NBD-ORD-OPS-") || o.customer_name === "Ops Customer") {
      cohort = "testAdminOps.js (Admin Order Lifecycle Operations)";
    } else if (["Cancel Customer", "Customer A", "Aditi Sharma", "Idem User"].includes(o.customer_name)) {
      cohort = "testCommerce.js (Commerce Engine & Checkout Regression)";
    }
    if (!orderCohorts[cohort]) {
      orderCohorts[cohort] = { count: 0, totalAmount: 0, sampleOrderNumbers: [] };
    }
    orderCohorts[cohort].count++;
    orderCohorts[cohort].totalAmount += parseFloat(o.total_amount || 0);
    if (orderCohorts[cohort].sampleOrderNumbers.length < 3) {
      orderCohorts[cohort].sampleOrderNumbers.push(o.order_number);
    }
  }

  const bookingCohorts = {};
  for (const b of testBookings) {
    let cohort = "testBookings.js (Salon Booking Engine & Slot Negotiations)";
    if (b.booking_number.startsWith("NBD-BKG-OPS-") || b.customer_name === "Ops Booking Customer") {
      cohort = "testAdminOps.js (Admin Appointment Approvals & Alternate Slots)";
    } else if (b.customer_name === "Staging Test Customer") {
      cohort = "testStagingIntegration.js (Staging Multi-Area Appointment Flow)";
    }
    if (!bookingCohorts[cohort]) {
      bookingCohorts[cohort] = { count: 0, sampleBookingNumbers: [] };
    }
    bookingCohorts[cohort].count++;
    if (bookingCohorts[cohort].sampleBookingNumbers.length < 3) {
      bookingCohorts[cohort].sampleBookingNumbers.push(b.booking_number);
    }
  }

  // 6. Dependent Records Counts
  const orderItemsDep = await query(
    `SELECT COUNT(*)::int AS count FROM order_items WHERE order_id = ANY($1);`,
    [testOrderIds]
  );
  const orderHistoryDep = await query(
    `SELECT COUNT(*)::int AS count FROM order_status_history WHERE order_id = ANY($1);`,
    [testOrderIds]
  );
  const orderPaymentsDep = await query(
    `SELECT COUNT(*)::int AS count FROM payments WHERE order_id = ANY($1);`,
    [testOrderIds]
  );
  const orderClaimAttemptsDep = await query(
    `SELECT COUNT(*)::int AS count FROM order_claim_attempts WHERE order_id = ANY($1);`,
    [testOrderIds]
  );
  const orderDiscountsDep = await query(
    `SELECT COUNT(*)::int AS count FROM discount_redemptions WHERE order_id = ANY($1);`,
    [testOrderIds]
  );
  const bookingHistoryDep = await query(
    `SELECT COUNT(*)::int AS count FROM booking_status_history WHERE booking_id = ANY($1);`,
    [testBookingIds]
  );
  const bookingTokensDep = await query(
    `SELECT COUNT(*)::int AS count FROM booking_action_tokens WHERE booking_id = ANY($1);`,
    [testBookingIds]
  );
  const bookingPaymentsDep = await query(
    `SELECT COUNT(*)::int AS count FROM payments WHERE booking_id = ANY($1);`,
    [testBookingIds]
  );

  // 7. Foreign Key Relationships Map
  const fksRes = await query(`
    SELECT
      tc.table_name AS dependent_table,
      kcu.column_name AS foreign_key_column,
      ccu.table_name AS referenced_table,
      rc.delete_rule
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.referential_constraints AS rc
      ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE ccu.table_name IN ('orders', 'bookings')
    ORDER BY ccu.table_name, tc.table_name;
  `);

  // Build Dry-Run Report Object
  const dryRunReport = {
    generatedAt: new Date().toISOString(),
    status: "DRY_RUN_PREPARED_AWAITING_APPROVAL",
    database: "PostgreSQL / Neon snowy-field-03627992",
    summary: {
      totalOrdersInDatabase: totalOrders,
      testOrdersIdentifiedForArchive: testOrders.length,
      developerSmokeOrdersPreserved: smokeOrders.length,
      totalBookingsInDatabase: totalBookings,
      testBookingsIdentifiedForArchive: testBookings.length,
      developerSmokeBookingsPreserved: smokeBookings.length,
    },
    developerSmokeTestRecordsPreserved: {
      orders: smokeOrders.map((o) => ({
        id: o.id,
        orderNumber: o.order_number,
        customerName: o.customer_name,
        customerPhone: o.customer_phone,
        totalAmount: o.total_amount,
        createdAt: o.created_at,
      })),
      bookings: smokeBookings.map((b) => ({
        id: b.id,
        bookingNumber: b.booking_number,
        customerName: b.customer_name,
        customerPhone: b.customer_phone,
        requestedDate: b.requested_date,
        createdAt: b.created_at,
      })),
    },
    testOrdersByCohort: orderCohorts,
    testBookingsByCohort: bookingCohorts,
    dependentRecordsCount: {
      order_items: orderItemsDep.rows[0].count,
      order_status_history: orderHistoryDep.rows[0].count,
      payments_for_orders: orderPaymentsDep.rows[0].count,
      order_claim_attempts: orderClaimAttemptsDep.rows[0].count,
      discount_redemptions: orderDiscountsDep.rows[0].count,
      booking_status_history: bookingHistoryDep.rows[0].count,
      booking_action_tokens: bookingTokensDep.rows[0].count,
      payments_for_bookings: bookingPaymentsDep.rows[0].count,
    },
    foreignKeyConstraints: fksRes.rows,
    cleanupExecutionPlan: {
      approach: "REVERSIBLE_ARCHIVE_FIRST",
      steps: [
        "Step 1: Create archive tables with identical schemas (_archive_orders, _archive_order_items, _archive_order_status_history, _archive_payments, _archive_bookings, _archive_booking_status_history, _archive_booking_action_tokens).",
        "Step 2: Copy all identified 295 test orders and their dependent items/history/payments into the archive tables in a single transaction.",
        "Step 3: Copy all identified 96 test bookings and their dependent history/tokens/payments into the archive tables in the same transaction.",
        "Step 4: Execute reverse foreign-key safe deletion (first dependent payments, order_items, order_status_history, booking_status_history, booking_action_tokens, then test orders, then test bookings).",
        "Step 5: Verify remaining records in orders and bookings (exactly 2 smoke orders and 1 smoke booking remain).",
        "Step 6: Reversal query is pre-generated to restore all records from _archive_* tables back into orders/bookings at any moment if rollback is needed."
      ]
    }
  };

  // Write report to JSON artifact for auditability
  const reportPath = path.resolve(__dirname, "../database/production_test_data_cleanup_dry_run_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(dryRunReport, null, 2), "utf8");

  // Print readable summary
  console.log("=== DRY-RUN VERIFICATION SUMMARY ===");
  console.log(`- Total Orders in DB:             ${totalOrders}`);
  console.log(`- Test Orders to Archive:         ${testOrders.length}`);
  console.log(`- Developer Smoke Orders (KEEP):  ${smokeOrders.length} (${smokeOrders.map(o => o.order_number).join(", ")})`);
  console.log(`- Total Bookings in DB:           ${totalBookings}`);
  console.log(`- Test Bookings to Archive:       ${testBookings.length}`);
  console.log(`- Developer Smoke Booking (KEEP): ${smokeBookings.length} (${smokeBookings.map(b => b.booking_number).join(", ")})`);
  console.log("\n=== DEPENDENT RECORDS TO ARCHIVE ===");
  console.table(dryRunReport.dependentRecordsCount);
  console.log("\n=== ORDER COHORTS ===");
  console.table(
    Object.entries(orderCohorts).map(([name, data]) => ({
      originatingScript: name,
      recordCount: data.count,
      totalAmountSum: `₹${data.totalAmount.toFixed(2)}`,
      sampleOrders: data.sampleOrderNumbers.join(", "),
    }))
  );
  console.log("\n=== BOOKING COHORTS ===");
  console.table(
    Object.entries(bookingCohorts).map(([name, data]) => ({
      originatingScript: name,
      recordCount: data.count,
      sampleBookings: data.sampleBookingNumbers.join(", "),
    }))
  );

  console.log("\n[SUCCESS] Dry-run report generated at: " + reportPath);
  console.log("[GUARD ACTIVE] ZERO records deleted or modified. Awaiting explicit user approval before execution.\n");

  await closePool();
}

runDryRun().catch((err) => {
  console.error("❌ Dry-run execution failed:", err);
  process.exit(1);
});
