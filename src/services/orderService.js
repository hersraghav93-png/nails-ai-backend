/**
 * ==========================================================================
 * ORDER SERVICE (`src/services/orderService.js`)
 * Nails by Divya Platform — Phase 2A Commerce Engine
 *
 * Implements production-grade order lifecycle operations:
 * - Transactional order creation from validated shopping cart
 * - Tamper-proof pricing recalculations & server-side promotional eligibility
 * - Immutable order item snapshots & audit history tracking
 * - Idempotency protection against duplicate requests / retries
 * - Strict ownership isolation for customer & guest orders
 * - Administrative order management with RBAC & audit logging
 * ==========================================================================
 */

"use strict";

const crypto = require("crypto");
const { getPool, query } = require("../db/pool");
const { calculateItemPricing, calculateCartTotals } = require("./pricingEngine");
const { queueNotification } = require("./notifications/notificationService");

// Allowed status values matching database check constraints
const ALLOWED_ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "IN_PRODUCTION",
  "COMPLETED",
  "CANCELLED",
];

const ALLOWED_FULFILMENT_STATUSES = [
  "UNFULFILLED",
  "READY_FOR_DISPATCH",
  "DISPATCHED",
  "DELIVERED",
  "RETURNED",
];

/**
 * Normalizes client IP address to valid PostgreSQL INET format.
 * @param {string|null} ip
 * @returns {string|null}
 */
function formatInetIp(ip) {
  if (!ip || typeof ip !== "string") return null;
  const clean = ip.trim();
  if (clean === "::1") return "127.0.0.1";
  if (clean.startsWith("::ffff:")) return clean.replace(/^::ffff:/, "");
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return clean;
  if (clean.includes(":")) return clean;
  return null;
}

/**
 * Validates Indian phone number (10 digits or E.164).
 * @param {string} phone
 * @returns {string} E.164 format (+91XXXXXXXXXX)
 */
function validateAndFormatPhone(phone) {
  if (!phone || typeof phone !== "string") {
    const err = new Error("Customer phone number is required.");
    err.code = "INVALID_PHONE";
    err.statusCode = 400;
    throw err;
  }
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
    return `+91${digits}`;
  }
  if (digits.length === 12 && digits.startsWith("91") && /^[6-9]\d{9}$/.test(digits.slice(2))) {
    return `+${digits}`;
  }
  const err = new Error("Please provide a valid 10-digit Indian mobile number.");
  err.code = "INVALID_PHONE";
  err.statusCode = 400;
  throw err;
}

/**
 * Validates customer name and optional email.
 */
function validateCustomerDetails(customer) {
  if (!customer || typeof customer !== "object") {
    const err = new Error("Customer contact details are required.");
    err.code = "CUSTOMER_REQUIRED";
    err.statusCode = 400;
    throw err;
  }

  const name = (customer.name || customer.fullName || "").trim();
  if (name.length < 2 || name.length > 100) {
    const err = new Error("Customer name must be between 2 and 100 characters.");
    err.code = "INVALID_NAME";
    err.statusCode = 400;
    throw err;
  }

  const phone = validateAndFormatPhone(customer.phone);

  let email = null;
  if (customer.email && typeof customer.email === "string" && customer.email.trim()) {
    const cleanEmail = customer.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      const err = new Error("Invalid customer email address format.");
      err.code = "INVALID_EMAIL";
      err.statusCode = 400;
      throw err;
    }
    email = cleanEmail;
  }

  return { name, phone, email };
}

/**
 * Validates shipping address payload.
 */
function validateShippingAddress(addr) {
  if (!addr || typeof addr !== "object") {
    const err = new Error("Shipping address is required.");
    err.code = "ADDRESS_REQUIRED";
    err.statusCode = 400;
    throw err;
  }

  const recipientName = (addr.recipient_name || addr.recipientName || addr.name || "").trim();
  if (recipientName.length < 2 || recipientName.length > 100) {
    const err = new Error("Recipient name must be between 2 and 100 characters.");
    err.code = "INVALID_RECIPIENT_NAME";
    err.statusCode = 400;
    throw err;
  }

  const phone = validateAndFormatPhone(addr.phone);

  const addressLine1 = (addr.address_line1 || addr.addressLine1 || addr.line1 || "").trim();
  if (!addressLine1 || addressLine1.length < 5 || addressLine1.length > 255) {
    const err = new Error("Address line 1 must be between 5 and 255 characters.");
    err.code = "INVALID_ADDRESS_LINE1";
    err.statusCode = 400;
    throw err;
  }

  const addressLine2 = (addr.address_line2 || addr.addressLine2 || addr.line2 || "").trim();
  const landmark = (addr.landmark || "").trim();

  const city = (addr.city || "").trim();
  if (!city || city.length < 2 || city.length > 50) {
    const err = new Error("City is required.");
    err.code = "INVALID_CITY";
    err.statusCode = 400;
    throw err;
  }

  const state = (addr.state || "").trim();
  if (!state || state.length < 2 || state.length > 50) {
    const err = new Error("State is required.");
    err.code = "INVALID_STATE";
    err.statusCode = 400;
    throw err;
  }

  const postalCode = (addr.postal_code || addr.postalCode || addr.pincode || addr.pin || "").toString().trim();
  if (!/^[1-9][0-9]{5}$/.test(postalCode)) {
    const err = new Error("Postal code must be a valid 6-digit Indian PIN code.");
    err.code = "INVALID_PINCODE";
    err.statusCode = 400;
    throw err;
  }

  return {
    recipient_name: recipientName,
    phone,
    address_line1: addressLine1,
    address_line2: addressLine2 || null,
    landmark: landmark || null,
    city,
    state,
    postal_code: postalCode,
  };
}

/**
 * Creates a new order from a shopping cart within an atomic PostgreSQL transaction.
 *
 * @param {object} params
 * @param {string} params.cartId
 * @param {string|null} [params.sessionToken]
 * @param {string|null} [params.userId]
 * @param {object} params.customer
 * @param {object} params.shippingAddress
 * @param {string|null} [params.customerNotes]
 * @param {string|null} [params.idempotencyKey]
 * @param {string|null} [params.ipAddress]
 * @returns {Promise<object>} Created order details and claim secret if guest
 */
async function createOrderFromCart({
  cartId,
  sessionToken = null,
  userId = null,
  customer,
  shippingAddress,
  customerNotes = null,
  idempotencyKey = null,
  ipAddress = null,
}) {
  const validatedCustomer = validateCustomerDetails(customer);
  const validatedAddress = validateShippingAddress(shippingAddress);

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    // 1. Idempotency Check: Prevent duplicate order placement on network retries
    if (idempotencyKey && typeof idempotencyKey === "string" && idempotencyKey.trim()) {
      const cleanKey = idempotencyKey.trim();
      const existingOrderRes = await client.query(
        `SELECT id, order_number, user_id, total_amount, order_status, payment_status, created_at 
         FROM orders 
         WHERE guest_session_token = $1 
            OR artist_internal_notes = $2;`,
        [`idem:${cleanKey}`, `[IDEMPOTENCY_KEY: ${cleanKey}]`]
      );

      if (existingOrderRes.rows.length > 0) {
        await client.query("COMMIT;");
        const existingOrder = existingOrderRes.rows[0];
        const fullExisting = await getOrderById(existingOrder.id, {
          userId,
          sessionToken,
          isAdmin: false,
          skipAuthCheck: true,
        });
        return {
          ...fullExisting,
          isDuplicate: true,
          message: "Order previously submitted and recorded (idempotent response).",
        };
      }
    }

    // 2. Resolve and Validate Cart
    const cartRes = await client.query(
      `SELECT * FROM carts WHERE id = $1 AND expires_at > CURRENT_TIMESTAMP FOR UPDATE;`,
      [cartId]
    );

    if (cartRes.rows.length === 0) {
      const err = new Error("Cart not found or session has expired.");
      err.code = "CART_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const cart = cartRes.rows[0];

    // Verify cart ownership if authenticated
    if (userId && cart.user_id && cart.user_id !== userId) {
      const err = new Error("Unauthorized: Cart does not belong to the authenticated user.");
      err.code = "CART_ACCESS_DENIED";
      err.statusCode = 403;
      throw err;
    }

    // 3. Retrieve Cart Items
    const itemsRes = await client.query(
      `SELECT 
         ci.id,
         ci.cart_id,
         ci.product_id,
         ci.shape,
         ci.length,
         ci.sizing_preset,
         ci.custom_measurements,
         ci.quantity,
         p.sku,
         p.name AS product_name,
         p.base_price,
         p.is_available,
         p.is_archived,
         COALESCE(
           (SELECT image_url FROM product_images WHERE product_id = p.id AND is_hero = TRUE LIMIT 1),
           (SELECT image_url FROM product_images WHERE product_id = p.id ORDER BY display_order ASC LIMIT 1)
         ) AS hero_image_url
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.cart_id = $1
       ORDER BY ci.created_at ASC;`,
      [cartId]
    );

    if (itemsRes.rows.length === 0) {
      const err = new Error("Cannot place an order with an empty cart. Please add products first.");
      err.code = "EMPTY_CART";
      err.statusCode = 400;
      throw err;
    }

    // 4. Validate Product Availability and Calculate Pricing Server-Side
    const pricedItems = [];
    for (const item of itemsRes.rows) {
      if (!item.is_available || item.is_archived) {
        const err = new Error(
          `Product '${item.product_name}' (${item.sku}) is currently unavailable or out of stock.`
        );
        err.code = "PRODUCT_UNAVAILABLE";
        err.statusCode = 400;
        throw err;
      }

      const pricing = calculateItemPricing(item, item.quantity);
      pricedItems.push({
        ...item,
        ...pricing,
      });
    }

    const totals = calculateCartTotals(pricedItems, 0.0);

    // 5. Generate Sequential Order Number
    const seqRes = await client.query(`SELECT nextval('order_number_seq') AS seq;`);
    const orderSeq = seqRes.rows[0].seq;
    const orderNumber = `NBD-ORD-${orderSeq}`;

    // 6. Generate Guest Claim Secret for unauthenticated orders
    let claimSecret = null;
    let guestClaimHash = null;
    if (!userId) {
      claimSecret = crypto.randomBytes(16).toString("hex");
      guestClaimHash = crypto.createHash("sha256").update(claimSecret).digest("hex");
    }

    const guestSessionToken = idempotencyKey
      ? `idem:${idempotencyKey.trim()}`
      : (sessionToken || cart.session_token);

    const artistInternalNotes = idempotencyKey
      ? `[IDEMPOTENCY_KEY: ${idempotencyKey.trim()}]`
      : null;

    // 7. Insert Order Record
    const orderInsertRes = await client.query(
      `INSERT INTO orders (
         order_number,
         user_id,
         guest_session_token,
         customer_name,
         customer_phone,
         customer_email,
         shipping_address,
         subtotal,
         discount_amount,
         shipping_fee,
         total_amount,
         currency,
         order_status,
         payment_status,
         fulfilment_status,
         guest_claim_hash,
         customer_notes,
         artist_internal_notes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *;`,
      [
        orderNumber,
        userId || null,
        guestSessionToken,
        validatedCustomer.name,
        validatedCustomer.phone,
        validatedCustomer.email,
        JSON.stringify(validatedAddress),
        totals.subtotal,
        totals.discountAmount,
        totals.shippingFee,
        totals.totalAmount,
        totals.currency,
        "PENDING",
        "PENDING",
        "UNFULFILLED",
        guestClaimHash,
        customerNotes ? customerNotes.substring(0, 500) : null,
        artistInternalNotes,
      ]
    );

    const order = orderInsertRes.rows[0];

    // 8. Insert Immutable Order Item Snapshots
    const createdItems = [];
    for (const item of pricedItems) {
      const variantDetails = {
        shape: item.shape,
        length: item.length,
        sizing_preset: item.sizing_preset,
        custom_measurements: item.custom_measurements,
        hero_image_url: item.hero_image_url,
        base_price: item.basePrice,
        unit_price: item.unitPrice,
        is_promo_applied: item.isPromoApplied,
        promo_applied: item.isPromoApplied ? "FESTIVE_599" : null,
        promo_name: item.promoName,
        item_discount: item.itemDiscount,
      };

      const itemInsertRes = await client.query(
        `INSERT INTO order_items (
           order_id,
           product_id,
           product_name,
           sku,
           unit_price,
           quantity,
           total_price,
           variant_details
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *;`,
        [
          order.id,
          item.product_id,
          item.product_name,
          item.sku,
          item.unitPrice,
          item.quantity,
          item.itemTotal,
          JSON.stringify(variantDetails),
        ]
      );
      createdItems.push(itemInsertRes.rows[0]);
    }

    // 9. Record Initial Status in order_status_history
    await client.query(
      `INSERT INTO order_status_history (
         order_id,
         status_type,
         from_status,
         to_status,
         actor_type,
         actor_id,
         notes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        order.id,
        "order",
        null,
        "PENDING",
        "customer",
        userId || null,
        "Order placed by customer via store cart checkout.",
      ]
    );

    // 10. Record Audit Log Entry
    await client.query(
      `INSERT INTO audit_logs (
         actor_id,
         actor_role,
         action,
         target_entity,
         target_id,
         diff,
         ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        userId || null,
        userId ? "customer" : "guest",
        "ORDER_CREATED",
        "orders",
        order.id,
        JSON.stringify({
          order_number: order.order_number,
          total_amount: order.total_amount,
          item_count: pricedItems.length,
          idempotency_key: idempotencyKey || null,
        }),
        formatInetIp(ipAddress),
      ]
    );

    // 11. Empty Cart Items Upon Order Placement
    await client.query(`DELETE FROM cart_items WHERE cart_id = $1;`, [cartId]);

    // Touch cart updated_at
    await client.query(
      `UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
      [cartId]
    );

    await client.query("COMMIT;");

    // Queue customer order confirmation notification
    try {
      const itemsSummary = createdItems.map((i) => `${i.quantity}x ${i.product_name}`).join(", ");
      const addr = order.shipping_address || {};
      const addrStr = `${addr.address_line1 || ""}, ${addr.city || ""}, PIN ${addr.postal_code || ""}`;

      await queueNotification({
        channel: "whatsapp",
        recipientPhone: order.customer_phone,
        templateKey: "ORDER_CONFIRMED",
        variables: {
          customerName: order.customer_name,
          orderNumber: order.order_number,
          orderId: order.id,
          itemsSummary,
          totalAmount: order.total_amount,
          deliveryAddress: addrStr,
        },
        idempotencyKey: `order_${order.id}_confirmed`,
      });
    } catch (notifErr) {
      console.warn(`⚠️ [Order Notification Error] Order ${order.id}: ${notifErr.message}`);
    }

    return {
      order: {
        id: order.id,
        orderNumber: order.order_number,
        userId: order.user_id,
        customerName: order.customer_name,
        customerPhone: order.customer_phone,
        customerEmail: order.customer_email,
        shippingAddress: order.shipping_address,
        subtotal: parseFloat(order.subtotal),
        discountAmount: parseFloat(order.discount_amount),
        shippingFee: parseFloat(order.shipping_fee),
        totalAmount: parseFloat(order.total_amount),
        currency: order.currency,
        orderStatus: order.order_status,
        paymentStatus: order.payment_status,
        fulfilmentStatus: order.fulfilment_status,
        customerNotes: order.customer_notes,
        createdAt: order.created_at,
      },
      items: createdItems.map((ci) => ({
        id: ci.id,
        productId: ci.product_id,
        productName: ci.product_name,
        sku: ci.sku,
        unitPrice: parseFloat(ci.unit_price),
        quantity: ci.quantity,
        totalPrice: parseFloat(ci.total_price),
        variantDetails: ci.variant_details,
      })),
      claimSecret, // Provided to guest for future lookup / account claiming
    };
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves an order by ID with strict ownership verification.
 *
 * @param {string} orderId Order UUID
 * @param {object} authContext { userId, sessionToken, claimSecret, isAdmin, skipAuthCheck }
 * @returns {Promise<object>}
 */
async function getOrderById(orderId, authContext = {}) {
  const { userId, sessionToken, claimSecret, isAdmin, skipAuthCheck } = authContext || {};

  const orderRes = await query(
    `SELECT * FROM orders WHERE id = $1;`,
    [orderId]
  );

  if (orderRes.rows.length === 0) {
    const err = new Error("Order not found.");
    err.code = "ORDER_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const order = orderRes.rows[0];

  // Ownership verification: prevent cross-customer access
  if (!skipAuthCheck && !isAdmin) {
    let isAuthorized = false;

    // Check if user is the authenticated owner
    if (userId && order.user_id === userId) {
      isAuthorized = true;
    }

    // Check if guest claim secret matches
    if (!isAuthorized && claimSecret && order.guest_claim_hash) {
      const hashedSecret = crypto.createHash("sha256").update(claimSecret.trim()).digest("hex");
      if (hashedSecret === order.guest_claim_hash) {
        isAuthorized = true;
      }
    }

    // Check if guest session token matches
    if (!isAuthorized && sessionToken) {
      if (
        order.guest_session_token === sessionToken ||
        order.guest_session_token === `idem:${sessionToken}`
      ) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      const err = new Error("Access denied: You do not have permission to view this order.");
      err.code = "FORBIDDEN_ORDER_ACCESS";
      err.statusCode = 403;
      throw err;
    }
  }

  // Fetch items
  const itemsRes = await query(
    `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC;`,
    [orderId]
  );

  // Fetch status history
  const historyRes = await query(
    `SELECT id, status_type, from_status, to_status, actor_type, notes, created_at 
     FROM order_status_history 
     WHERE order_id = $1 
     ORDER BY created_at ASC;`,
    [orderId]
  );

  // Retrieve shipment information
  const shipmentRes = await query(
    `SELECT id, courier_name, tracking_number, tracking_url, dispatched_at, delivered_at, created_at
     FROM shipments
     WHERE order_id = $1
     ORDER BY created_at DESC
     LIMIT 1;`,
    [orderId]
  );

  // Retrieve related communication history
  const notificationsRes = await query(
    `SELECT id, channel, template_name, status, retry_count, scheduled_for, created_at,
            template_variables->>'__manualWaLink' AS manual_wa_link
     FROM notification_jobs
     WHERE template_variables->>'orderId' = $1 OR template_variables->>'orderNumber' = $2
     ORDER BY created_at DESC
     LIMIT 10;`,
    [orderId, order.order_number]
  );

  // Retrieve verified payment ledger record if present
  const paymentRes = await query(
    `SELECT id, payment_method, amount, currency, status, gateway_payment_id, verified_at, created_at
     FROM payments
     WHERE order_id = $1
     ORDER BY created_at DESC
     LIMIT 1;`,
    [orderId]
  );

  return {
    order: {
      id: order.id,
      orderNumber: order.order_number,
      userId: order.user_id,
      customerName: order.customer_name,
      customerPhone: order.customer_phone,
      customerEmail: order.customer_email,
      shippingAddress: order.shipping_address,
      subtotal: parseFloat(order.subtotal),
      discountAmount: parseFloat(order.discount_amount),
      shippingFee: parseFloat(order.shipping_fee),
      totalAmount: parseFloat(order.total_amount),
      currency: order.currency,
      orderStatus: order.order_status,
      paymentStatus: order.payment_status,
      fulfilmentStatus: order.fulfilment_status,
      customerNotes: order.customer_notes,
      courierName: shipmentRes.rows[0] ? shipmentRes.rows[0].courier_name : null,
      trackingNumber: shipmentRes.rows[0] ? shipmentRes.rows[0].tracking_number : null,
      trackingUrl: shipmentRes.rows[0] ? shipmentRes.rows[0].tracking_url : null,
      dispatchedAt: shipmentRes.rows[0] ? shipmentRes.rows[0].dispatched_at : null,
      deliveredAt: shipmentRes.rows[0] ? shipmentRes.rows[0].delivered_at : null,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
    },
    items: itemsRes.rows.map((ci) => ({
      id: ci.id,
      productId: ci.product_id,
      productName: ci.product_name,
      sku: ci.sku,
      unitPrice: parseFloat(ci.unit_price),
      quantity: ci.quantity,
      totalPrice: parseFloat(ci.total_price),
      variantDetails: ci.variant_details,
    })),
    statusHistory: historyRes.rows.map((sh) => ({
      id: sh.id,
      statusType: sh.status_type,
      fromStatus: sh.from_status,
      toStatus: sh.to_status,
      actorType: sh.actor_type,
      notes: sh.notes,
      createdAt: sh.created_at,
    })),
    shipment: shipmentRes.rows[0] ? {
      id: shipmentRes.rows[0].id,
      courierName: shipmentRes.rows[0].courier_name,
      trackingNumber: shipmentRes.rows[0].tracking_number,
      trackingUrl: shipmentRes.rows[0].tracking_url,
      dispatchedAt: shipmentRes.rows[0].dispatched_at,
      deliveredAt: shipmentRes.rows[0].delivered_at,
    } : null,
    payment: paymentRes.rows[0] ? {
      id: paymentRes.rows[0].id,
      paymentMethod: paymentRes.rows[0].payment_method,
      amount: parseFloat(paymentRes.rows[0].amount),
      currency: paymentRes.rows[0].currency,
      status: paymentRes.rows[0].status,
      transactionReference: paymentRes.rows[0].gateway_payment_id,
      verifiedAt: paymentRes.rows[0].verified_at,
      createdAt: paymentRes.rows[0].created_at,
    } : null,
    notifications: notificationsRes.rows.map((n) => ({
      id: n.id,
      channel: n.channel,
      templateName: n.template_name,
      status: n.status,
      retryCount: n.retry_count,
      scheduledFor: n.scheduled_for,
      createdAt: n.created_at,
      manualWaLink: n.manual_wa_link,
    })),
  };
}

/**
 * Retrieves order history for an authenticated customer.
 *
 * @param {string} userId Authenticated user UUID
 * @param {object} [pagination] { limit, offset }
 * @returns {Promise<{ orders: Array<object>, total: number }>}
 */
async function getCustomerOrders(userId, { limit = 20, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM orders WHERE user_id = $1;`,
    [userId]
  );
  const total = countRes.rows[0].total;

  const ordersRes = await query(
    `SELECT 
       o.id,
       o.order_number,
       o.subtotal,
       o.discount_amount,
       o.total_amount,
       o.currency,
       o.order_status,
       o.payment_status,
       o.fulfilment_status,
       o.created_at,
       (SELECT COUNT(*)::int FROM order_items WHERE order_id = o.id) AS item_count
     FROM orders o
     WHERE o.user_id = $1
     ORDER BY o.created_at DESC
     LIMIT $2 OFFSET $3;`,
    [userId, safeLimit, safeOffset]
  );

  return {
    orders: ordersRes.rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      subtotal: parseFloat(row.subtotal),
      discountAmount: parseFloat(row.discount_amount),
      totalAmount: parseFloat(row.total_amount),
      currency: row.currency,
      orderStatus: row.order_status,
      paymentStatus: row.payment_status,
      fulfilmentStatus: row.fulfilment_status,
      itemCount: row.item_count,
      createdAt: row.created_at,
    })),
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}

/**
 * Cancels an eligible unpaid order (must be PENDING and unpaid).
 *
 * @param {string} orderId Order UUID
 * @param {object} authContext { userId, sessionToken, claimSecret, isAdmin, reason }
 * @returns {Promise<object>} Updated order details
 */
async function cancelOrder(orderId, authContext = {}) {
  const { userId, sessionToken, claimSecret, isAdmin, reason } = authContext;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE;`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      const err = new Error("Order not found.");
      err.code = "ORDER_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const order = orderRes.rows[0];

    // Ownership check
    if (!isAdmin) {
      let isAuthorized = false;
      if (userId && order.user_id === userId) isAuthorized = true;
      if (!isAuthorized && claimSecret && order.guest_claim_hash) {
        const hashedSecret = crypto.createHash("sha256").update(claimSecret.trim()).digest("hex");
        if (hashedSecret === order.guest_claim_hash) isAuthorized = true;
      }
      if (!isAuthorized && sessionToken) {
        if (
          order.guest_session_token === sessionToken ||
          order.guest_session_token === `idem:${sessionToken}`
        ) {
          isAuthorized = true;
        }
      }

      if (!isAuthorized) {
        const err = new Error("Access denied: You do not have permission to cancel this order.");
        err.code = "FORBIDDEN_ORDER_ACCESS";
        err.statusCode = 403;
        throw err;
      }
    }

    // Cancellation eligibility check: can only cancel before production starts and when unpaid
    if (order.order_status !== "PENDING") {
      const err = new Error(
        `Order ${order.order_number} cannot be cancelled because it is in '${order.order_status}' status. Studio orders can only be cancelled while in PENDING status before hand-painting begins.`
      );
      err.code = "ORDER_CANNOT_BE_CANCELLED";
      err.statusCode = 400;
      throw err;
    }

    if (order.payment_status === "VERIFIED") {
      const err = new Error(
        `Order ${order.order_number} has verified payment. Please contact studio support for refund processing.`
      );
      err.code = "PAYMENT_ALREADY_VERIFIED";
      err.statusCode = 400;
      throw err;
    }

    // Update order status to CANCELLED
    await client.query(
      `UPDATE orders 
       SET order_status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1;`,
      [orderId]
    );

    // Record in order_status_history
    const actorType = isAdmin ? "operator" : "customer";
    const cancelNote = reason || (isAdmin ? "Order cancelled by studio administration." : "Order cancelled by customer before production.");

    await client.query(
      `INSERT INTO order_status_history (
         order_id,
         status_type,
         from_status,
         to_status,
         actor_type,
         actor_id,
         notes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        orderId,
        "order",
        order.order_status,
        "CANCELLED",
        actorType,
        userId || null,
        cancelNote,
      ]
    );

    await client.query("COMMIT;");

    // Queue cancellation notification
    try {
      await queueNotification({
        recipientPhone: order.customer_phone,
        templateKey: "ORDER_CANCELLED",
        variables: {
          customerName: order.customer_name,
          orderNumber: order.order_number,
          orderId: order.id,
          cancellationReason: cancelNote,
        },
        idempotencyKey: `order_${order.id}_cancelled`,
      });
    } catch (notifErr) {
      console.warn(`⚠️ [Order Notification Error] Order ${order.id}: ${notifErr.message}`);
    }

    return getOrderById(orderId, {
      userId,
      sessionToken,
      isAdmin,
      skipAuthCheck: true,
    });
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Administrative order listing with filtering, pagination, and customer information.
 *
 * @param {object} filters { status, paymentStatus, fulfilmentStatus, search, limit, offset }
 * @returns {Promise<{ orders: Array<object>, total: number }>}
 */
async function adminListOrders(filters = {}) {
  const {
    status,
    paymentStatus,
    fulfilmentStatus,
    search,
    limit = 20,
    offset = 0,
  } = filters;

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const whereClauses = [];
  const params = [];
  let paramIdx = 1;

  if (status) {
    whereClauses.push(`o.order_status = $${paramIdx++}`);
    params.push(status);
  }

  if (paymentStatus) {
    whereClauses.push(`o.payment_status = $${paramIdx++}`);
    params.push(paymentStatus);
  }

  if (fulfilmentStatus) {
    whereClauses.push(`o.fulfilment_status = $${paramIdx++}`);
    params.push(fulfilmentStatus);
  }

  if (search && typeof search === "string" && search.trim()) {
    const term = `%${search.trim()}%`;
    whereClauses.push(
      `(o.order_number ILIKE $${paramIdx} OR o.customer_name ILIKE $${paramIdx} OR o.customer_phone ILIKE $${paramIdx})`
    );
    params.push(term);
    paramIdx++;
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM orders o ${whereSql};`,
    params
  );
  const total = countRes.rows[0].total;

  params.push(safeLimit, safeOffset);
  const ordersRes = await query(
    `SELECT 
       o.id,
       o.order_number,
       o.user_id,
       o.customer_name,
       o.customer_phone,
       o.customer_email,
       o.subtotal,
       o.discount_amount,
       o.total_amount,
       o.currency,
       o.order_status,
       o.payment_status,
       o.fulfilment_status,
       o.created_at,
       (SELECT COUNT(*)::int FROM order_items WHERE order_id = o.id) AS item_count
     FROM orders o
     ${whereSql}
     ORDER BY o.created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++};`,
    params
  );

  return {
    orders: ordersRes.rows.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      userId: r.user_id,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      customerEmail: r.customer_email,
      subtotal: parseFloat(r.subtotal),
      discountAmount: parseFloat(r.discount_amount),
      totalAmount: parseFloat(r.total_amount),
      currency: r.currency,
      orderStatus: r.order_status,
      paymentStatus: r.payment_status,
      fulfilmentStatus: r.fulfilment_status,
      itemCount: r.item_count,
      createdAt: r.created_at,
    })),
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}

/**
 * Administrative order status update with permission verification and audit history.
 *
 * @param {string} orderId
 * @param {object} updateData { orderStatus, fulfilmentStatus, notes }
 * @param {object} adminUser { id, roles }
 * @param {string|null} [ipAddress]
 * @returns {Promise<object>} Updated order details
 */
async function adminUpdateOrderStatus(orderId, updateData, adminUser, ipAddress = null) {
  const {
    orderStatus,
    fulfilmentStatus,
    courierName,
    courier_name,
    trackingNumber,
    tracking_number,
    trackingUrl,
    tracking_url,
    dispatchedAt,
    dispatched_at,
    notes,
    notifyCustomer = true,
  } = updateData;

  const resolvedCourier = courierName || courier_name || null;
  const resolvedTracking = trackingNumber || tracking_number || null;
  const resolvedTrackingUrl = trackingUrl || tracking_url || null;
  const resolvedDispatchedAt = dispatchedAt || dispatched_at || null;

  // Strict boundary: General order status updates must never modify payment status
  if (updateData.paymentStatus !== undefined || updateData.payment_status !== undefined) {
    const err = new Error(
      "Payment status cannot be updated via the general order status endpoint. Use the dedicated payment verification endpoint (PATCH /api/admin/orders/:orderId/payment-status)."
    );
    err.code = "PAYMENT_STATUS_SEPARATE_MUTATION";
    err.statusCode = 400;
    throw err;
  }

  if (orderStatus && !ALLOWED_ORDER_STATUSES.includes(orderStatus)) {
    const err = new Error(
      `Invalid order status '${orderStatus}'. Allowed: ${ALLOWED_ORDER_STATUSES.join(", ")}.`
    );
    err.code = "INVALID_ORDER_STATUS";
    err.statusCode = 400;
    throw err;
  }

  if (fulfilmentStatus && !ALLOWED_FULFILMENT_STATUSES.includes(fulfilmentStatus)) {
    const err = new Error(
      `Invalid fulfilment status '${fulfilmentStatus}'. Allowed: ${ALLOWED_FULFILMENT_STATUSES.join(", ")}.`
    );
    err.code = "INVALID_FULFILMENT_STATUS";
    err.statusCode = 400;
    throw err;
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE;`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      const err = new Error("Order not found.");
      err.code = "ORDER_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const order = orderRes.rows[0];
    const newOrderStatus = orderStatus || order.order_status;
    const newFulfilmentStatus = fulfilmentStatus || order.fulfilment_status;

    // Business Safety Rule: Production and fulfilment progression require verified payment
    const ADVANCED_ORDER_STATUSES = ["IN_PRODUCTION", "COMPLETED"];
    const ADVANCED_FULFILMENT_STATUSES = ["READY_FOR_DISPATCH", "DISPATCHED", "DELIVERED"];

    if (orderStatus && ADVANCED_ORDER_STATUSES.includes(newOrderStatus) && order.payment_status !== "VERIFIED") {
      const err = new Error(
        `Cannot move order ${order.order_number} to '${newOrderStatus}'. Payment status is currently '${order.payment_status}' (payment must be 'VERIFIED' before bespoke nail production begins).`
      );
      err.code = "PAYMENT_NOT_VERIFIED";
      err.statusCode = 400;
      throw err;
    }

    if (fulfilmentStatus && ADVANCED_FULFILMENT_STATUSES.includes(newFulfilmentStatus) && order.payment_status !== "VERIFIED") {
      const err = new Error(
        `Cannot advance fulfilment status to '${newFulfilmentStatus}' for order ${order.order_number}. Payment status is currently '${order.payment_status}' (payment must be 'VERIFIED' before order can be prepared or dispatched).`
      );
      err.code = "PAYMENT_NOT_VERIFIED";
      err.statusCode = 400;
      throw err;
    }

    // Update order
    await client.query(
      `UPDATE orders 
       SET order_status = $1, fulfilment_status = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3;`,
      [newOrderStatus, newFulfilmentStatus, orderId]
    );

    // Shipment record upsert if courier, tracking, or DISPATCHED status is provided
    let activeShipment = null;
    if (resolvedCourier || resolvedTracking || fulfilmentStatus === "DISPATCHED") {
      const existingShipRes = await client.query(
        `SELECT id FROM shipments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE;`,
        [orderId]
      );

      const dispatchTime = resolvedDispatchedAt ? new Date(resolvedDispatchedAt) : (fulfilmentStatus === "DISPATCHED" ? new Date() : null);

      if (existingShipRes.rows.length > 0) {
        const updateShipRes = await client.query(
          `UPDATE shipments
           SET courier_name = COALESCE($1, courier_name),
               tracking_number = COALESCE($2, tracking_number),
               tracking_url = COALESCE($3, tracking_url),
               dispatched_at = COALESCE($4, dispatched_at)
           WHERE id = $5
           RETURNING *;`,
          [
            resolvedCourier,
            resolvedTracking,
            resolvedTrackingUrl,
            dispatchTime,
            existingShipRes.rows[0].id,
          ]
        );
        activeShipment = updateShipRes.rows[0];
      } else {
        const insertShipRes = await client.query(
          `INSERT INTO shipments (
             order_id,
             courier_name,
             tracking_number,
             tracking_url,
             dispatched_at
           ) VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_TIMESTAMP))
           RETURNING *;`,
          [
            orderId,
            resolvedCourier,
            resolvedTracking,
            resolvedTrackingUrl,
            dispatchTime,
          ]
        );
        activeShipment = insertShipRes.rows[0];
      }
    }

    // Record order status history if changed
    if (orderStatus && orderStatus !== order.order_status) {
      await client.query(
        `INSERT INTO order_status_history (
           order_id,
           status_type,
           from_status,
           to_status,
           actor_type,
           actor_id,
           notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [
          orderId,
          "order",
          order.order_status,
          orderStatus,
          "operator",
          adminUser.id,
          notes || `Order status updated to ${orderStatus} by operator.`,
        ]
      );
    }

    // Record fulfilment status history if changed
    if (fulfilmentStatus && fulfilmentStatus !== order.fulfilment_status) {
      await client.query(
        `INSERT INTO order_status_history (
           order_id,
           status_type,
           from_status,
           to_status,
           actor_type,
           actor_id,
           notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [
          orderId,
          "fulfilment",
          order.fulfilment_status,
          fulfilmentStatus,
          "operator",
          adminUser.id,
          notes || `Fulfilment status updated to ${fulfilmentStatus} by operator.`,
        ]
      );
    }

    // Record Audit Log
    await client.query(
      `INSERT INTO audit_logs (
         actor_id,
         actor_role,
         action,
         target_entity,
         target_id,
         diff,
         ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        adminUser.id,
        (adminUser.roles && adminUser.roles[0]) || "operator",
        "ORDER_STATUS_UPDATED",
        "orders",
        orderId,
        JSON.stringify({
          previous: {
            order_status: order.order_status,
            fulfilment_status: order.fulfilment_status,
          },
          updated: {
            order_status: newOrderStatus,
            fulfilment_status: newFulfilmentStatus,
            courier: resolvedCourier,
            tracking: resolvedTracking,
          },
          notes: notes || null,
        }),
        formatInetIp(ipAddress),
      ]
    );

    await client.query("COMMIT;");

    // Queue appropriate customer notifications
    if (notifyCustomer !== false) {
      try {
        if (orderStatus && orderStatus !== order.order_status) {
          if (orderStatus === "IN_PRODUCTION") {
            await queueNotification({
              recipientPhone: order.customer_phone,
              templateKey: "ORDER_IN_PRODUCTION",
              variables: {
                customerName: order.customer_name,
                orderNumber: order.order_number,
                orderId: order.id,
              },
              idempotencyKey: `order_${order.id}_in_prod`,
            });
          } else if (orderStatus === "CANCELLED") {
            await queueNotification({
              recipientPhone: order.customer_phone,
              templateKey: "ORDER_CANCELLED",
              variables: {
                customerName: order.customer_name,
                orderNumber: order.order_number,
                orderId: order.id,
                cancellationReason: notes || "Order cancelled by studio administration.",
              },
              idempotencyKey: `order_${order.id}_cancelled`,
            });
          }
        }

        if (fulfilmentStatus && fulfilmentStatus !== order.fulfilment_status) {
          if (fulfilmentStatus === "READY_FOR_DISPATCH") {
            await queueNotification({
              recipientPhone: order.customer_phone,
              templateKey: "ORDER_READY_FOR_DISPATCH",
              variables: {
                customerName: order.customer_name,
                orderNumber: order.order_number,
                orderId: order.id,
              },
              idempotencyKey: `order_${order.id}_ready_dispatch`,
            });
          } else if (fulfilmentStatus === "DISPATCHED") {
            const ship = activeShipment || {};
            await queueNotification({
              recipientPhone: order.customer_phone,
              templateKey: "ORDER_DISPATCHED",
              variables: {
                customerName: order.customer_name,
                orderNumber: order.order_number,
                orderId: order.id,
                courierName: ship.courier_name || resolvedCourier || "Express Courier",
                trackingNumber: ship.tracking_number || resolvedTracking || "Pending Assignment",
                trackingUrl: ship.tracking_url || resolvedTrackingUrl || null,
                dispatchedDate: ship.dispatched_at ? new Date(ship.dispatched_at).toLocaleDateString("en-IN") : new Date().toLocaleDateString("en-IN"),
              },
              idempotencyKey: `order_${order.id}_dispatched_${ship.tracking_number || Date.now()}`,
            });
          } else if (fulfilmentStatus === "DELIVERED") {
            await queueNotification({
              recipientPhone: order.customer_phone,
              templateKey: "ORDER_DELIVERED",
              variables: {
                customerName: order.customer_name,
                orderNumber: order.order_number,
                orderId: order.id,
              },
              idempotencyKey: `order_${order.id}_delivered`,
            });
          }
        }
      } catch (notifErr) {
        console.warn(`⚠️ [Order Notification Error] Order ${order.id}: ${notifErr.message}`);
      }
    }

    return getOrderById(orderId, { isAdmin: true, skipAuthCheck: true });
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

const ALLOWED_MANUAL_PAYMENT_STATUSES = [
  "VERIFIED",
  "FAILED",
  "MANUAL_VERIFY_REQ",
  "INITIATED",
  "PENDING",
];

const ALLOWED_PAYMENT_METHODS = ["manual_upi", "cash", "razorpay"];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dedicated administrative payment verification operation.
 * Manually updates the order payment status, records verified payment ledger record,
 * appends to order_status_history, and creates an immutable audit log entry.
 *
 * @param {string} orderId UUID of target order
 * @param {object} verifyData
 * @param {string} verifyData.paymentStatus Target status e.g. 'VERIFIED', 'FAILED', 'MANUAL_VERIFY_REQ'
 * @param {string} [verifyData.paymentMethod='manual_upi'] 'manual_upi' | 'cash' | 'razorpay'
 * @param {string} [verifyData.transactionReference] Transaction ID / UPI UTR / Bank ref
 * @param {number} [verifyData.amount] Verified amount in INR (defaults to order total_amount)
 * @param {string} [verifyData.notes] Administrative notes explaining verification
 * @param {string} [verifyData.idempotencyKey] Optional idempotency key
 * @param {object} adminUser Authenticated user { id, roles, permissions }
 * @param {string|null} [ipAddress=null] Client IP
 * @returns {Promise<object>}
 */
async function adminVerifyOrderPayment(orderId, verifyData, adminUser, ipAddress = null) {
  if (!orderId || !UUID_REGEX.test(orderId)) {
    const err = new Error(`Invalid order ID format '${orderId}'. Must be a valid UUID.`);
    err.code = "INVALID_ORDER_ID";
    err.statusCode = 400;
    throw err;
  }

  const {
    paymentStatus,
    paymentMethod = "manual_upi",
    transactionReference = null,
    amount,
    notes,
    idempotencyKey = null,
  } = verifyData || {};

  if (!paymentStatus || typeof paymentStatus !== "string") {
    const err = new Error("Payment status is required.");
    err.code = "PAYMENT_STATUS_REQUIRED";
    err.statusCode = 400;
    throw err;
  }

  const normalizedStatus = paymentStatus.toUpperCase().trim();
  if (!ALLOWED_MANUAL_PAYMENT_STATUSES.includes(normalizedStatus)) {
    const err = new Error(
      `Invalid payment status '${paymentStatus}'. Allowed transitions: ${ALLOWED_MANUAL_PAYMENT_STATUSES.join(", ")}.`
    );
    err.code = "INVALID_PAYMENT_STATUS";
    err.statusCode = 400;
    throw err;
  }

  const normalizedMethod = (paymentMethod || "manual_upi").toLowerCase().trim();
  if (!ALLOWED_PAYMENT_METHODS.includes(normalizedMethod)) {
    const err = new Error(
      `Invalid payment method '${paymentMethod}'. Allowed: ${ALLOWED_PAYMENT_METHODS.join(", ")}.`
    );
    err.code = "INVALID_PAYMENT_METHOD";
    err.statusCode = 400;
    throw err;
  }

  const cleanUtr = transactionReference && typeof transactionReference === "string" && transactionReference.trim()
    ? transactionReference.trim()
    : null;

  const cleanIdempotencyKey = idempotencyKey && typeof idempotencyKey === "string" && idempotencyKey.trim()
    ? idempotencyKey.trim()
    : null;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE;`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      const err = new Error(`Order '${orderId}' not found.`);
      err.code = "ORDER_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const order = orderRes.rows[0];
    const previousStatus = order.payment_status;

    // 1. Reject payment verification on cancelled orders
    if (order.order_status === "CANCELLED") {
      const err = new Error(
        `Cannot verify payment for order ${order.order_number} because it has already been CANCELLED.`
      );
      err.code = "ORDER_ALREADY_CANCELLED";
      err.statusCode = 400;
      throw err;
    }

    // 2. Terminal refund check
    if (previousStatus === "REFUNDED") {
      const err = new Error(
        `Order ${order.order_number} is in terminal REFUNDED status and cannot be modified.`
      );
      err.code = "INVALID_PAYMENT_TRANSITION";
      err.statusCode = 400;
      throw err;
    }

    // 3. Strict verified-payment downgrade protection:
    // If previous status is VERIFIED, reject every transition to a different status through this endpoint.
    if (previousStatus === "VERIFIED" && normalizedStatus !== "VERIFIED") {
      const err = new Error(
        `Cannot transition order ${order.order_number} from 'VERIFIED' to '${normalizedStatus}'. Verified payments cannot be modified or downgraded through this endpoint. Process a formal refund if funds were returned.`
      );
      err.code = "INVALID_PAYMENT_TRANSITION";
      err.statusCode = 400;
      throw err;
    }

    // 4. Amount parsing and safe money/decimal validation
    const orderPayable = parseFloat(order.total_amount);
    const orderPayableCents = Math.round(orderPayable * 100);

    let verifiedAmount;
    if (amount !== undefined && amount !== null) {
      const parsed = Number(amount);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        const err = new Error(`Invalid verified amount '${amount}'. Must be a positive finite number.`);
        err.code = "INVALID_AMOUNT";
        err.statusCode = 400;
        throw err;
      }
      verifiedAmount = Math.round(parsed * 100) / 100;
    } else {
      verifiedAmount = orderPayable;
    }

    const verifiedAmountCents = Math.round(verifiedAmount * 100);

    // When status is VERIFIED, full amount equality is strictly required
    if (normalizedStatus === "VERIFIED") {
      if (verifiedAmountCents < orderPayableCents) {
        const err = new Error(
          `Cannot verify payment for order ${order.order_number}. Verified amount (₹${verifiedAmount.toFixed(2)}) is less than total payable amount (₹${orderPayable.toFixed(2)}). Partial payments cannot be marked as VERIFIED.`
        );
        err.code = "PAYMENT_AMOUNT_INSUFFICIENT";
        err.statusCode = 400;
        throw err;
      }

      if (verifiedAmountCents > orderPayableCents) {
        const err = new Error(
          `Cannot verify payment for order ${order.order_number}. Verified amount (₹${verifiedAmount.toFixed(2)}) exceeds total payable amount (₹${orderPayable.toFixed(2)}).`
        );
        err.code = "PAYMENT_AMOUNT_EXCEEDS_TOTAL";
        err.statusCode = 400;
        throw err;
      }
    }

    // 5. Idempotency Key Handling & Duplicate Submission Protection
    if (cleanIdempotencyKey) {
      const existingKeyRes = await client.query(
        `SELECT * FROM payments WHERE idempotency_key = $1 FOR UPDATE;`,
        [cleanIdempotencyKey]
      );

      if (existingKeyRes.rows.length > 0) {
        const priorPayment = existingKeyRes.rows[0];

        // Conflict check 1: Same key used on another order
        if (priorPayment.order_id !== order.id) {
          const err = new Error(
            `Idempotency key '${cleanIdempotencyKey}' has already been used for another order (${priorPayment.order_id}).`
          );
          err.code = "IDEMPOTENCY_KEY_CONFLICT";
          err.statusCode = 409;
          throw err;
        }

        // Conflict check 2: Same key, same order, but different payload
        const priorAmountCents = Math.round(parseFloat(priorPayment.amount) * 100);
        const priorUtr = priorPayment.gateway_payment_id || null;
        const incomingUtr = cleanUtr || null;

        const isPayloadIdentical =
          priorPayment.status === normalizedStatus &&
          priorPayment.payment_method === normalizedMethod &&
          priorAmountCents === verifiedAmountCents &&
          priorUtr === incomingUtr;

        if (!isPayloadIdentical) {
          const err = new Error(
            `Idempotency key '${cleanIdempotencyKey}' was previously submitted for order ${order.order_number} with a different payload.`
          );
          err.code = "IDEMPOTENCY_KEY_CONFLICT";
          err.statusCode = 409;
          throw err;
        }

        // Exact match with same idempotency key: return original successful result
        await client.query("COMMIT;");
        const existingOrder = await getOrderById(orderId, { isAdmin: true, skipAuthCheck: true });
        return {
          success: true,
          orderId: order.id,
          orderNumber: order.order_number,
          previousPaymentStatus: previousStatus,
          paymentStatus: normalizedStatus,
          paymentMethod: normalizedMethod,
          amount: verifiedAmount,
          transactionReference: priorUtr,
          alreadyVerified: normalizedStatus === "VERIFIED",
          message: `Payment status is already '${normalizedStatus}'. Request handled idempotently with verified idempotency key.`,
          order: existingOrder.order,
          payment: existingOrder.payment || null,
        };
      }
    } else {
      // No idempotency key provided: check if order is already in target status with identical payment
      if (previousStatus === normalizedStatus) {
        const existingPayRes = await client.query(
          `SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE;`,
          [order.id]
        );
        if (existingPayRes.rows.length > 0) {
          const p = existingPayRes.rows[0];
          const priorAmountCents = Math.round(parseFloat(p.amount) * 100);
          const priorUtr = p.gateway_payment_id || null;
          const incomingUtr = cleanUtr || null;

          if (
            p.payment_method === normalizedMethod &&
            priorAmountCents === verifiedAmountCents &&
            (incomingUtr === null || priorUtr === incomingUtr)
          ) {
            await client.query("COMMIT;");
            const existingOrder = await getOrderById(orderId, { isAdmin: true, skipAuthCheck: true });
            return {
              success: true,
              orderId: order.id,
              orderNumber: order.order_number,
              previousPaymentStatus: previousStatus,
              paymentStatus: normalizedStatus,
              paymentMethod: normalizedMethod,
              amount: verifiedAmount,
              transactionReference: priorUtr,
              alreadyVerified: normalizedStatus === "VERIFIED",
              message: `Payment status is already '${normalizedStatus}'. Request handled idempotently.`,
              order: existingOrder.order,
              payment: existingOrder.payment || null,
            };
          }
        }
      }
    }

    // 6. Proactive check for duplicate transaction reference / UTR across other orders
    if (cleanUtr) {
      const dupUtrRes = await client.query(
        `SELECT id, order_id FROM payments WHERE gateway_payment_id = $1 AND order_id != $2 LIMIT 1;`,
        [cleanUtr, order.id]
      );

      if (dupUtrRes.rows.length > 0) {
        const err = new Error(
          `Transaction reference (UTR) '${cleanUtr}' has already been recorded for another order.`
        );
        err.code = "DUPLICATE_TRANSACTION_REFERENCE";
        err.statusCode = 409;
        throw err;
      }
    }

    // 7. Upsert payments ledger entry
    const existingPayRes = await client.query(
      `SELECT id, idempotency_key FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE;`,
      [order.id]
    );

    let paymentRecord = null;
    const finalIdempotencyKey = cleanIdempotencyKey ||
      (existingPayRes.rows.length > 0 && existingPayRes.rows[0].idempotency_key
        ? existingPayRes.rows[0].idempotency_key
        : `pay_${order.id}_${normalizedStatus.toLowerCase()}_${Date.now()}`);

    if (existingPayRes.rows.length > 0) {
      const updatePayRes = await client.query(
        `UPDATE payments
         SET status = $1,
             payment_method = $2,
             amount = $3,
             gateway_payment_id = COALESCE($4, gateway_payment_id),
             idempotency_key = $5,
             verified_at = $6
         WHERE id = $7
         RETURNING *;`,
        [
          normalizedStatus,
          normalizedMethod,
          verifiedAmount,
          cleanUtr,
          finalIdempotencyKey,
          normalizedStatus === "VERIFIED" ? new Date() : null,
          existingPayRes.rows[0].id,
        ]
      );
      paymentRecord = updatePayRes.rows[0];
    } else {
      const insertPaymentRes = await client.query(
        `INSERT INTO payments (
           order_id,
           payment_method,
           amount,
           currency,
           status,
           gateway_payment_id,
           idempotency_key,
           verified_at,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         RETURNING *;`,
        [
          order.id,
          normalizedMethod,
          verifiedAmount,
          order.currency || "INR",
          normalizedStatus,
          cleanUtr,
          finalIdempotencyKey,
          normalizedStatus === "VERIFIED" ? new Date() : null,
        ]
      );
      paymentRecord = insertPaymentRes.rows[0];
    }

    // 8. Update orders table
    await client.query(
      `UPDATE orders
       SET payment_status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2;`,
      [normalizedStatus, order.id]
    );

    // 9. Record in order_status_history
    const historyNote = notes && typeof notes === "string" && notes.trim()
      ? notes.trim()
      : `Payment status updated from ${previousStatus} to ${normalizedStatus} via manual verification (${normalizedMethod}${cleanUtr ? ` - Ref: ${cleanUtr}` : ""}).`;

    await client.query(
      `INSERT INTO order_status_history (
         order_id,
         status_type,
         from_status,
         to_status,
         actor_type,
         actor_id,
         notes
       ) VALUES ($1, 'payment', $2, $3, 'operator', $4, $5);`,
      [order.id, previousStatus, normalizedStatus, adminUser.id || null, historyNote]
    );

    // 10. Record in immutable audit_logs
    const actorRole = (adminUser.roles && adminUser.roles[0]) || "operator";
    await client.query(
      `INSERT INTO audit_logs (
         actor_id,
         actor_role,
         action,
         target_entity,
         target_id,
         diff,
         ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        adminUser.id || null,
        actorRole,
        normalizedStatus === "VERIFIED" ? "ORDER_PAYMENT_VERIFIED" : "ORDER_PAYMENT_STATUS_UPDATED",
        "orders",
        order.id,
        JSON.stringify({
          previous: {
            payment_status: previousStatus,
          },
          updated: {
            payment_status: normalizedStatus,
            payment_method: normalizedMethod,
            amount: verifiedAmount,
            transaction_reference: cleanUtr,
          },
          notes: notes || null,
        }),
        formatInetIp(ipAddress),
      ]
    );

    await client.query("COMMIT;");

    const enriched = await getOrderById(order.id, { isAdmin: true, skipAuthCheck: true });
    return {
      success: true,
      orderId: order.id,
      orderNumber: order.order_number,
      previousPaymentStatus: previousStatus,
      paymentStatus: normalizedStatus,
      paymentMethod: normalizedMethod,
      amount: verifiedAmount,
      transactionReference: cleanUtr,
      alreadyVerified: false,
      message: `Payment status for order ${order.order_number} successfully updated to '${normalizedStatus}'.`,
      order: enriched.order,
      payment: paymentRecord
        ? {
            id: paymentRecord.id,
            paymentMethod: paymentRecord.payment_method,
            amount: parseFloat(paymentRecord.amount),
            currency: paymentRecord.currency,
            status: paymentRecord.status,
            transactionReference: paymentRecord.gateway_payment_id,
            verifiedAt: paymentRecord.verified_at,
            createdAt: paymentRecord.created_at,
          }
        : null,
    };
  } catch (err) {
    await client.query("ROLLBACK;");

    // Catch PostgreSQL unique violation 23505 safely
    if (err.code === "23505") {
      if (err.constraint === "uq_payments_gateway_id" || (err.message && err.message.includes("gateway_payment_id"))) {
        const customErr = new Error(
          `Transaction reference (UTR) '${cleanUtr || transactionReference}' has already been recorded for another payment.`
        );
        customErr.code = "DUPLICATE_TRANSACTION_REFERENCE";
        customErr.statusCode = 409;
        throw customErr;
      }
      if (err.constraint === "payments_idempotency_key_key" || (err.message && err.message.includes("idempotency_key"))) {
        const customErr = new Error(
          `Idempotency key '${cleanIdempotencyKey || idempotencyKey}' conflict: already used in payment ledger.`
        );
        customErr.code = "IDEMPOTENCY_KEY_CONFLICT";
        customErr.statusCode = 409;
        throw customErr;
      }
    }

    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  validateAndFormatPhone,
  validateCustomerDetails,
  validateShippingAddress,
  createOrderFromCart,
  getOrderById,
  getCustomerOrders,
  cancelOrder,
  adminListOrders,
  adminUpdateOrderStatus,
  adminVerifyOrderPayment,
};
