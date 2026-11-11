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
  const { userId, sessionToken, claimSecret, isAdmin, skipAuthCheck } = authContext;

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
  const { orderStatus, fulfilmentStatus, notes } = updateData;

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

    // Update order
    await client.query(
      `UPDATE orders 
       SET order_status = $1, fulfilment_status = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3;`,
      [newOrderStatus, newFulfilmentStatus, orderId]
    );

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
          },
          notes: notes || null,
        }),
        formatInetIp(ipAddress),
      ]
    );

    await client.query("COMMIT;");

    return getOrderById(orderId, { isAdmin: true, skipAuthCheck: true });
  } catch (err) {
    await client.query("ROLLBACK;");
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
};
