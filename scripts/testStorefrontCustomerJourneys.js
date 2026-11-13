/**
 * ==============================================================================
 * STOREFRONT CUSTOMER JOURNEYS & COMMERCE VERIFICATION SUITE
 * (`scripts/testStorefrontCustomerJourneys.js`)
 * Nails by Divya Platform — Phase 3B Storefront & Commerce Integration
 *
 * Verifies end-to-end customer shopping, cart, checkout, booking, and account journeys:
 * - Test 1: Public Catalog & Sizing Verification (22 sets, ₹599 festive offer)
 * - Test 2: Guest Cart, Server Pricing & Guest Checkout (PENDING status & claim secret)
 * - Test 3: Authenticated Customer Cart Merging, Checkout & Order History Isolation
 * - Test 4: At-Home Appointment Request Lifecycle (REQUESTED status & NULL price preservation)
 * - Test 5: Payment Boundary & Tamper Resistance (Strict PENDING payment, server recalculation)
 * - Test 6: Cross-Customer Isolation & Idempotency Key Replay Protection
 * ==============================================================================
 */

"use strict";

const { query } = require("../src/db/pool");
const { getOrCreateCart, addItemToCart, getCartDetails, clearCart, claimGuestCart } = require("../src/services/cartService");
const { createOrderFromCart, getOrderById, getCustomerOrders } = require("../src/services/orderService");
const { listAvailableServices, createAppointmentRequest, getAppointmentById, getCustomerAppointments } = require("../src/services/bookingService");
const { calculateItemPricing, calculateCartTotals } = require("../src/services/pricingEngine");

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    testsPassed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    testsFailed++;
  }
}

async function runTests() {
  console.log("\n==============================================================================");
  console.log("NAILS BY DIVYA — STOREFRONT COMMERCE & BOOKING VERIFICATION (PHASE 3B)");
  console.log("==============================================================================\n");

  // ----------------------------------------------------------------------------
  // TEST 1: PUBLIC CATALOG & SIZING VERIFICATION
  // ----------------------------------------------------------------------------
  console.log("▶ [Test 1] Public Catalog & Promotional Pricing Verification");
  try {
    const productsRes = await query(
      `SELECT p.*, pc.name AS category_name,
         COALESCE(
           (SELECT image_url FROM product_images WHERE product_id = p.id AND is_hero = TRUE LIMIT 1),
           (SELECT image_url FROM product_images WHERE product_id = p.id ORDER BY display_order ASC LIMIT 1)
         ) AS primary_image_url
       FROM products p
       JOIN product_categories pc ON pc.id = p.category_id
       WHERE p.is_archived = FALSE
       ORDER BY p.created_at ASC;`
    );

    assert(productsRes.rows.length === 22, `Found exactly 22 active handcrafted press-on sets (got ${productsRes.rows.length})`);

    const sampleSet = productsRes.rows.find((p) => p.sku === "WED-005") || productsRes.rows[0];
    const pricing = calculateItemPricing(sampleSet, 1);

    assert(pricing.basePrice === 999, `Base catalog price for WED-005 is ₹999 (got ₹${pricing.basePrice})`);
    assert(pricing.unitPrice === 599, `Active Festive Offer discount applied to ₹599 (got ₹${pricing.unitPrice})`);
    assert(pricing.isPromoApplied === true, "Promotional flag isPromoApplied is true");
    assert(sampleSet.primary_image_url && sampleSet.primary_image_url.includes("WED-005"), "Verified hero image asset linked to product");
  } catch (err) {
    console.error("Test 1 error:", err);
    testsFailed++;
  }

  // ----------------------------------------------------------------------------
  // TEST 2: GUEST CART, SERVER PRICING & GUEST CHECKOUT
  // ----------------------------------------------------------------------------
  console.log("\n▶ [Test 2] Guest Cart, Tamper-Proof Pricing & Guest Checkout Flow");
  let guestSessionToken = null;
  let guestCartId = null;
  let guestOrderId = null;
  let guestClaimSecret = null;

  try {
    const cart = await getOrCreateCart(null, null);
    guestCartId = cart.id;
    guestSessionToken = cart.session_token;

    assert(Boolean(guestCartId && guestSessionToken), `Initialized guest shopping cart session (${guestSessionToken.slice(0, 8)}...)`);

    // Add item to cart
    const itemData = {
      sku: "WED-005",
      shape: "Almond",
      length: "Medium",
      sizing_preset: "M",
      quantity: 2,
    };

    const cartWithItem = await addItemToCart(guestCartId, itemData);
    assert(cartWithItem.items.length === 1, `Cart contains 1 line item (got ${cartWithItem.items.length})`);
    assert(cartWithItem.totals.subtotal === 1998, `Subtotal for 2 sets at ₹999 is ₹1998 (got ₹${cartWithItem.totals.subtotal})`);
    assert(cartWithItem.totals.discountAmount === 800, `Festive offer discount is ₹800 (got ₹${cartWithItem.totals.discountAmount})`);
    assert(cartWithItem.totals.totalAmount === 1198, `Grand total for 2 sets is ₹1198 (got ₹${cartWithItem.totals.totalAmount})`);
    assert(cartWithItem.totals.shippingFee === 0, "Delivery fee baseline is ₹0 (delivery arrangements confirmed by studio before fulfilment)");

    // Checkout guest order
    const orderResult = await createOrderFromCart({
      cartId: guestCartId,
      sessionToken: guestSessionToken,
      userId: null,
      customer: {
        name: "Aanya Verma",
        phone: "9810012345",
        email: "aanya@example.com",
      },
      shippingAddress: {
        recipient_name: "Aanya Verma",
        phone: "9810012345",
        address_line1: "A-44, Vasant Vihar",
        city: "New Delhi",
        state: "Delhi",
        postal_code: "110057",
      },
      customerNotes: "Please verify thumbnail sizing before painting",
    });

    guestOrderId = orderResult.order.id;
    guestClaimSecret = orderResult.claimSecret;

    assert(orderResult.order.orderStatus === "PENDING", `Order created in PENDING status (got ${orderResult.order.orderStatus})`);
    assert(orderResult.order.paymentStatus === "PENDING", `Payment status is strictly PENDING (got ${orderResult.order.paymentStatus})`);
    assert(orderResult.order.totalAmount === 1198, `Order grand total is ₹1198 (got ₹${orderResult.order.totalAmount})`);
    assert(Boolean(guestClaimSecret), "Guest claim secret issued for guest order access");

    // Cart items should be cleared after checkout
    const postCheckoutCart = await getCartDetails(guestCartId);
    assert(postCheckoutCart.items.length === 0, "Shopping cart emptied automatically after successful order creation");
  } catch (err) {
    console.error("Test 2 error:", err);
    testsFailed++;
  }

  // ----------------------------------------------------------------------------
  // TEST 3: AUTHENTICATED CUSTOMER CART MERGING & ORDER ISOLATION
  // ----------------------------------------------------------------------------
  console.log("\n▶ [Test 3] Authenticated Customer Cart Claim, Merge & Order History");
  try {
    // Retrieve test customer from database
    const userRes = await query("SELECT id, phone, email FROM users WHERE is_active = TRUE ORDER BY created_at ASC LIMIT 1;");
    const testUser = userRes.rows[0];
    assert(Boolean(testUser), `Found active test customer in database (${testUser.id})`);

    // 1. Create a guest cart with item CAS-004
    const tempGuestCart = await getOrCreateCart(null, null);
    await addItemToCart(tempGuestCart.id, {
      sku: "CAS-004",
      shape: "Oval",
      length: "Short",
      sizing_preset: "S",
      quantity: 1,
    });

    // 2. Claim guest cart into authenticated customer account
    const claimedCart = await claimGuestCart(tempGuestCart.session_token, testUser.id);
    assert(claimedCart.user_id === testUser.id, `Cart ownership successfully transferred to customer ${testUser.id}`);

    // 3. Place order as authenticated customer
    const authOrderRes = await createOrderFromCart({
      cartId: claimedCart.id,
      sessionToken: null,
      userId: testUser.id,
      customer: {
        name: "Verified Customer",
        phone: testUser.phone || "9811002233",
        email: testUser.email || "customer@example.com",
      },
      shippingAddress: {
        recipient_name: "Verified Customer",
        phone: testUser.phone || "9811002233",
        address_line1: "Sector 54, Golf Course Road",
        city: "Gurgaon",
        state: "Haryana",
        postal_code: "122002",
      },
    });

    assert(authOrderRes.order.userId === testUser.id, "Order successfully linked to customer account");
    assert(authOrderRes.order.orderStatus === "PENDING", "Authenticated order entered PENDING status");

    // 4. Query customer order history
    const customerOrders = await getCustomerOrders(testUser.id);
    assert(customerOrders.orders.length > 0, `Customer order history retrieved ${customerOrders.orders.length} orders`);
    const foundAuthOrder = customerOrders.orders.find((o) => o.id === authOrderRes.order.id);
    assert(Boolean(foundAuthOrder), "Newly placed order is visible in customer order history");
  } catch (err) {
    console.error("Test 3 error:", err);
    testsFailed++;
  }

  // ----------------------------------------------------------------------------
  // TEST 4: AT-HOME APPOINTMENT REQUEST LIFECYCLE
  // ----------------------------------------------------------------------------
  console.log("\n▶ [Test 4] At-Home Appointment Request Flow & NULL Pricing Preservation");
  try {
    const services = await listAvailableServices();
    assert(services.length === 5, `Service catalog contains 5 salon services (got ${services.length})`);

    const gelExt = services.find((s) => s.id === "gel_extensions");
    const custom3d = services.find((s) => s.id === "custom_3d_art");

    assert(gelExt && gelExt.effectivePrice === 999, `Gel Extensions promotional starting price is ₹999 (got ₹${gelExt.effectivePrice})`);
    assert(custom3d && custom3d.effectivePrice === null, "3D & Custom Artistry base price is strictly NULL (requires custom quotation)");
    assert(custom3d && custom3d.isCustomQuote === true, "3D & Custom Artistry isCustomQuote is true");

    // Submit appointment request with add-on
    const addonId = (gelExt.addons && gelExt.addons[0] && gelExt.addons[0].id) || null;
    const bookingRes = await createAppointmentRequest({
      userId: null,
      customer: {
        name: "Meera Kapoor",
        phone: "9876543210",
        email: "meera@example.com",
      },
      serviceId: "gel_extensions",
      addonIds: addonId ? [addonId] : [], // French tip detailing dynamically resolved
      serviceAddress: {
        address_line1: "Villa 12, Nirvana Country, Sector 50",
        city: "Gurgaon",
        state: "Haryana",
        postal_code: "122018",
      },
      requestedDate: "2026-11-28",
      requestedTimeSlot: "03:00 PM - 05:00 PM",
      customerNotes: "Bridal event consultation",
    });

    const booking = bookingRes.booking;
    assert(booking.bookingStatus === "REQUESTED", `Booking correctly entered REQUESTED status (got ${booking.bookingStatus})`);
    assert(booking.estimatedTotal === null, "Estimated total preserved as NULL because French Tip add-on requires custom quote");
    assert(Boolean(bookingRes.claimSecret), "Claim secret generated for guest appointment tracking");
  } catch (err) {
    console.error("Test 4 error:", err);
    testsFailed++;
  }

  // ----------------------------------------------------------------------------
  // TEST 5: PAYMENT BOUNDARY & TAMPER RESISTANCE
  // ----------------------------------------------------------------------------
  console.log("\n▶ [Test 5] Payment Boundary Disclosures & Server-Side Tamper Resistance");
  try {
    // Create new cart and verify client cannot manipulate unit price
    const tamperCart = await getOrCreateCart(null, null);
    await addItemToCart(tamperCart.id, {
      sku: "PAR-003", // Base price ₹1299 -> Festive ₹599
      shape: "Coffin",
      length: "Long",
      sizing_preset: "M",
      quantity: 1,
      // Attempt client-side price tampering
      unit_price: 1.0,
      total_amount: 1.0,
    });

    const pricedCart = await getCartDetails(tamperCart.id);
    assert(pricedCart.items[0].unitPrice === 599, `Server enforced official ₹599 festive price, ignoring client price 1.0 (got ₹${pricedCart.items[0].unitPrice})`);
    assert(pricedCart.totals.totalAmount === 599, `Server recalculated grand total to ₹599 (got ₹${pricedCart.totals.totalAmount})`);
    assert(pricedCart.totals.shippingFee === 0, "Delivery fee is ₹0 baseline (charges confirmed by studio prior to fulfilment)");
  } catch (err) {
    console.error("Test 5 error:", err);
    testsFailed++;
  }

  // ----------------------------------------------------------------------------
  // TEST 6: ISOLATION & IDEMPOTENCY REPLAY PROTECTION
  // ----------------------------------------------------------------------------
  console.log("\n▶ [Test 6] Cross-Customer Isolation & Idempotency Replay Protection");
  try {
    // 1. Guest order without claim secret must be rejected
    let isolationBlocked = false;
    try {
      await getOrderById(guestOrderId, { userId: null, claimSecret: null });
    } catch (err) {
      if (err.statusCode === 403 || err.code === "FORBIDDEN") {
        isolationBlocked = true;
      }
    }
    assert(isolationBlocked === true, "Unauthenticated request without claim secret is blocked (HTTP 403 Forbidden)");

    // 2. Guest order with valid claim secret is accessible
    const accessibleOrder = await getOrderById(guestOrderId, { claimSecret: guestClaimSecret });
    assert(accessibleOrder.order.id === guestOrderId, "Guest order successfully accessed with valid claim secret");

    // 3. Idempotency replay check
    const idempotencyKey = `nbd-test-idemp-${Date.now()}`;
    const idempCart = await getOrCreateCart(null, null);
    await addItemToCart(idempCart.id, {
      sku: "WORK-002",
      shape: "Round",
      length: "Short",
      sizing_preset: "S",
      quantity: 1,
    });

    const orderPayload = {
      cartId: idempCart.id,
      sessionToken: idempCart.session_token,
      customer: { name: "Rhea Sen", phone: "9812345678" },
      shippingAddress: {
        recipient_name: "Rhea Sen",
        phone: "9812345678",
        address_line1: "Flat 101, Mayur Vihar Phase 1",
        city: "Delhi",
        state: "Delhi",
        postal_code: "110091",
      },
      idempotencyKey,
    };

    const firstSubmission = await createOrderFromCart(orderPayload);
    const secondSubmission = await createOrderFromCart(orderPayload);

    assert(secondSubmission.isDuplicate === true, "Duplicate submission with same idempotency key detected");
    assert(firstSubmission.order.id === secondSubmission.order.id, "Second submission safely returned identical order without re-creating");
  } catch (err) {
    console.error("Test 6 error:", err);
    testsFailed++;
  }

  // ----------------------------------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------------------------------
  console.log("\n==============================================================================");
  console.log(`TEST SUMMARY: ${testsPassed} passed, ${testsFailed} failed.`);
  console.log("==============================================================================\n");

  if (testsFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
