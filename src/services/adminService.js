/**
 * ==========================================================================
 * ADMINISTRATIVE SERVICE (`src/services/adminService.js`)
 * Nails by Divya Platform — Phase 2C Admin Operations Engine
 *
 * Implements business operations, metrics aggregation, customer management,
 * catalog availability control, staff roster inspection, and audit logging:
 * - Real-time metrics distinguishing paid vs unpaid revenues
 * - Customer profiles, addresses, sizing, and isolated histories
 * - Product and service availability toggles with audit logs
 * - Staff roles and permissions directory
 * - Business settings and immutable audit trails
 * ==========================================================================
 */

"use strict";

const { getPool, query } = require("../db/pool");

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
 * Validates UUID v4 format.
 * @param {string} id
 * @returns {boolean}
 */
function isValidUuid(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Computes date range bounds based on string key or explicit timestamps.
 * @param {string} range 'all' | 'today' | '7d' | '30d'
 * @param {string} [customFrom]
 * @param {string} [customTo]
 * @returns {{ from: Date|null, to: Date|null }}
 */
function parseDateRange(range = "all", customFrom = null, customTo = null) {
  if (customFrom) {
    const fromDate = new Date(customFrom);
    const toDate = customTo ? new Date(customTo) : new Date();
    if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime())) {
      return { from: fromDate, to: toDate };
    }
  }

  const now = new Date();
  switch (range) {
    case "today": {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { from: startOfDay, to: now };
    }
    case "7d": {
      const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { from, to: now };
    }
    case "30d": {
      const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { from, to: now };
    }
    case "all":
    default:
      return { from: null, to: null };
  }
}

/**
 * Retrieves comprehensive operational overview metrics from live database.
 * Strictly separates paid revenue from unpaid/pending order values.
 *
 * @param {object} [filters] { range, dateFrom, dateTo }
 * @returns {Promise<object>}
 */
async function getEnrichedOverview(filters = {}) {
  const { range = "all", dateFrom, dateTo } = filters;
  const { from, to } = parseDateRange(range, dateFrom, dateTo);

  const orderTimeClause = from && to ? `WHERE created_at >= $1 AND created_at <= $2` : "";
  const bookingTimeClause = from && to ? `WHERE created_at >= $1 AND created_at <= $2` : "";
  const params = from && to ? [from.toISOString(), to.toISOString()] : [];

  // 1. Order metrics & revenue breakdown
  const orderMetricsRes = await query(
    `SELECT
       COUNT(*)::int AS total_orders,
       COUNT(*) FILTER (WHERE order_status = 'PENDING')::int AS pending_orders,
       COUNT(*) FILTER (WHERE order_status = 'IN_PRODUCTION')::int AS in_production_orders,
       COUNT(*) FILTER (WHERE order_status = 'DISPATCHED')::int AS dispatched_orders,
       COUNT(*) FILTER (WHERE order_status = 'DELIVERED')::int AS completed_orders,
       COUNT(*) FILTER (WHERE order_status = 'CANCELLED')::int AS cancelled_orders,
       COALESCE(SUM(CASE WHEN order_status != 'CANCELLED' THEN total_amount ELSE 0 END), 0.00) AS total_order_amount,
       COALESCE(SUM(CASE WHEN payment_status IN ('VERIFIED', 'PAID') AND order_status != 'CANCELLED' THEN total_amount ELSE 0 END), 0.00) AS paid_revenue,
       COALESCE(SUM(CASE WHEN payment_status IN ('PENDING', 'UNPAID', 'INITIATED', 'MANUAL_VERIFY_REQ') AND order_status != 'CANCELLED' THEN total_amount ELSE 0 END), 0.00) AS pending_payment_amount,
       COALESCE(SUM(CASE WHEN payment_status IN ('REFUNDED', 'PARTIALLY_REFUNDED') THEN total_amount ELSE 0 END), 0.00) AS refunded_amount
     FROM orders ${orderTimeClause};`,
    params
  );
  const orderStats = orderMetricsRes.rows[0] || {};

  // 2. Booking / Appointment metrics
  const bookingMetricsRes = await query(
    `SELECT
       COUNT(*)::int AS total_bookings,
       COUNT(*) FILTER (WHERE booking_status = 'REQUESTED')::int AS requested_bookings,
       COUNT(*) FILTER (WHERE booking_status = 'DIVYA_REVIEWING')::int AS reviewing_bookings,
       COUNT(*) FILTER (WHERE booking_status = 'ALTERNATIVE_PROPOSED')::int AS alternative_proposed_bookings,
       COUNT(*) FILTER (WHERE booking_status = 'CONFIRMED')::int AS confirmed_bookings,
       COUNT(*) FILTER (WHERE booking_status = 'CONFIRMED' AND requested_date >= CURRENT_DATE)::int AS upcoming_bookings,
       COUNT(*) FILTER (WHERE booking_status = 'IN_PROGRESS')::int AS in_progress_bookings,
       COUNT(*) FILTER (WHERE booking_status = 'COMPLETED')::int AS completed_bookings,
       COUNT(*) FILTER (WHERE booking_status = 'DECLINED')::int AS declined_bookings,
       COUNT(*) FILTER (WHERE booking_status IN ('CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_ARTIST'))::int AS cancelled_bookings
     FROM bookings ${bookingTimeClause};`,
    params
  );
  const bookingStats = bookingMetricsRes.rows[0] || {};

  // 3. Customer counts
  const customerCountRes = await query(
    `SELECT COUNT(DISTINCT user_id)::int AS total_customers FROM customer_profiles;`
  );
  const totalCustomers = customerCountRes.rows[0] ? customerCountRes.rows[0].total_customers : 0;

  // 4. Catalog summary & designs count
  const [productStatsRes, serviceStatsRes, usersCountRes, designsCountRes] = await Promise.all([
    query(
      `SELECT
         COUNT(*)::int AS total_products,
         COUNT(*) FILTER (WHERE is_available = TRUE AND is_archived = FALSE)::int AS active_products
       FROM products;`
    ),
    query(
      `SELECT
         COUNT(*)::int AS total_services,
         COUNT(*) FILTER (WHERE is_active = TRUE)::int AS active_services
       FROM services;`
    ),
    query(`SELECT COUNT(*)::int AS count FROM users;`),
    query(`SELECT COUNT(*)::int AS count FROM portfolio_designs;`),
  ]);

  // 5. Recent 5 orders
  const recentOrdersRes = await query(
    `SELECT
       o.id,
       o.order_number,
       o.customer_name,
       o.customer_phone,
       o.order_status,
       o.payment_status,
       o.total_amount,
       o.created_at,
       (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count
     FROM orders o
     ORDER BY o.created_at DESC
     LIMIT 5;`
  );

  // 6. Recent 5 appointment requests
  const recentBookingsRes = await query(
    `SELECT
       b.id,
       b.booking_number,
       b.customer_name,
       b.customer_phone,
       b.service_id,
       s.name AS service_name,
       b.requested_date,
       b.requested_time_slot,
       b.booking_status,
       b.created_at
     FROM bookings b
     LEFT JOIN services s ON s.id = b.service_id
     ORDER BY b.created_at DESC
     LIMIT 5;`
  );

  return {
    range,
    dateFrom: from ? from.toISOString() : null,
    dateTo: to ? to.toISOString() : null,
    totalUsers: usersCountRes.rows[0].count,
    totalProducts: productStatsRes.rows[0] ? productStatsRes.rows[0].total_products : 0,
    totalServices: serviceStatsRes.rows[0] ? serviceStatsRes.rows[0].total_services : 0,
    totalOrders: orderStats.total_orders,
    totalBookings: bookingStats.total_bookings,
    totalPortfolioDesigns: designsCountRes.rows[0].count,
    orders: {
      total: orderStats.total_orders,
      pending: orderStats.pending_orders,
      inProduction: orderStats.in_production_orders,
      dispatched: orderStats.dispatched_orders,
      completed: orderStats.completed_orders,
      cancelled: orderStats.cancelled_orders,
    },
    bookings: {
      total: bookingStats.total_bookings,
      newRequests: bookingStats.requested_bookings,
      inReview: bookingStats.reviewing_bookings,
      alternativeProposed: bookingStats.alternative_proposed_bookings,
      confirmed: bookingStats.confirmed_bookings,
      upcoming: bookingStats.upcoming_bookings,
      inProgress: bookingStats.in_progress_bookings,
      completed: bookingStats.completed_bookings,
      declined: bookingStats.declined_bookings,
      cancelled: bookingStats.cancelled_bookings,
    },
    financials: {
      totalOrderAmount: parseFloat(orderStats.total_order_amount) || 0,
      paidRevenue: parseFloat(orderStats.paid_revenue) || 0,
      pendingPaymentAmount: parseFloat(orderStats.pending_payment_amount) || 0,
      refundedAmount: parseFloat(orderStats.refunded_amount) || 0,
    },
    customers: {
      total: totalCustomers,
    },
    catalog: {
      totalProducts: productStatsRes.rows[0] ? productStatsRes.rows[0].total_products : 0,
      activeProducts: productStatsRes.rows[0] ? productStatsRes.rows[0].active_products : 0,
      totalServices: serviceStatsRes.rows[0] ? serviceStatsRes.rows[0].total_services : 0,
      activeServices: serviceStatsRes.rows[0] ? serviceStatsRes.rows[0].active_services : 0,
    },
    recentOrders: recentOrdersRes.rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      orderStatus: row.order_status,
      paymentStatus: row.payment_status,
      totalAmount: parseFloat(row.total_amount) || 0,
      itemCount: row.item_count,
      createdAt: row.created_at,
    })),
    recentBookings: recentBookingsRes.rows.map((row) => ({
      id: row.id,
      bookingNumber: row.booking_number,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      serviceId: row.service_id,
      serviceName: row.service_name || row.service_id,
      requestedDate: row.requested_date instanceof Date ? row.requested_date.toISOString().slice(0, 10) : row.requested_date,
      requestedTimeSlot: row.requested_time_slot,
      bookingStatus: row.booking_status,
      createdAt: row.created_at,
    })),
  };
}

/**
 * Retrieves paginated list of customers with search and interaction summaries.
 *
 * @param {object} [options] { search, limit, offset }
 * @returns {Promise<{ customers: Array<object>, total: number, limit: number, offset: number }>}
 */
async function listCustomers({ search = null, limit = 20, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const whereConditions = [];
  const params = [];
  let paramIdx = 1;

  if (search && typeof search === "string" && search.trim()) {
    const term = `%${search.trim()}%`;
    whereConditions.push(`(cp.full_name ILIKE $${paramIdx} OR u.phone ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx})`);
    params.push(term);
    paramIdx++;
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  // Count total matching customers
  const countRes = await query(
    `SELECT COUNT(DISTINCT u.id)::int AS total
     FROM users u
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     ${whereClause};`,
    params
  );
  const total = countRes.rows[0] ? countRes.rows[0].total : 0;

  // Retrieve customer records with order & booking count subqueries
  const customersRes = await query(
    `SELECT
       u.id,
       u.phone,
       u.email,
       u.is_active,
       u.created_at,
       cp.full_name,
       cp.sizing_preset,
       cp.preferred_nail_shape,
       cp.preferred_nail_length,
       (SELECT COUNT(*)::int FROM orders o WHERE o.user_id = u.id) AS order_count,
       (SELECT COUNT(*)::int FROM bookings b WHERE b.user_id = u.id) AS booking_count,
       (
         SELECT MAX(act.created_at)
         FROM (
           SELECT created_at FROM orders WHERE user_id = u.id
           UNION ALL
           SELECT created_at FROM bookings WHERE user_id = u.id
         ) act
       ) AS last_activity
     FROM users u
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     ${whereClause}
     ORDER BY u.created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++};`,
    [...params, safeLimit, safeOffset]
  );

  return {
    customers: customersRes.rows.map((row) => ({
      id: row.id,
      phone: row.phone,
      email: row.email,
      fullName: row.full_name || "Guest Customer",
      sizingPreset: row.sizing_preset || null,
      preferredNailShape: row.preferred_nail_shape || null,
      preferredNailLength: row.preferred_nail_length || null,
      isActive: row.is_active,
      orderCount: row.order_count || 0,
      bookingCount: row.booking_count || 0,
      lastActivity: row.last_activity || null,
      createdAt: row.created_at,
    })),
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}

/**
 * Retrieves full customer details including nail profile, saved addresses, orders, and appointments.
 *
 * @param {string} customerId User UUID
 * @returns {Promise<object>}
 */
async function getCustomerDetails(customerId) {
  if (!isValidUuid(customerId)) {
    const err = new Error("Invalid customer ID format. Must be a UUID.");
    err.code = "INVALID_CUSTOMER_ID";
    err.statusCode = 400;
    throw err;
  }

  // 1. User & profile
  const userRes = await query(
    `SELECT
       u.id,
       u.phone,
       u.email,
       u.is_active,
       u.created_at,
       u.updated_at,
       cp.id AS profile_id,
       cp.full_name,
       cp.preferred_nail_shape,
       cp.preferred_nail_length,
       cp.custom_nail_measurements,
       cp.sizing_preset,
       cp.allergies_or_notes
     FROM users u
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     WHERE u.id = $1;`,
    [customerId]
  );

  if (userRes.rows.length === 0) {
    const err = new Error("Customer not found.");
    err.code = "CUSTOMER_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const u = userRes.rows[0];

  // 2. Saved addresses
  const addressesRes = await query(
    `SELECT
       id,
       recipient_name,
       recipient_phone,
       address_line1,
       address_line2,
       landmark,
       city,
       state,
       postal_code,
       is_default_shipping,
       is_default_service,
       created_at
     FROM user_addresses
     WHERE user_id = $1
     ORDER BY is_default_shipping DESC, created_at DESC;`,
    [customerId]
  );

  // 3. Orders history
  const ordersRes = await query(
    `SELECT
       id,
       order_number,
       order_status,
       payment_status,
       fulfilment_status,
       total_amount,
       created_at
     FROM orders
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20;`,
    [customerId]
  );

  // 4. Appointments history
  const bookingsRes = await query(
    `SELECT
       b.id,
       b.booking_number,
       b.service_id,
       s.name AS service_name,
       b.requested_date,
       b.requested_time_slot,
       b.booking_status,
       b.estimated_total,
       b.created_at
     FROM bookings b
     LEFT JOIN services s ON s.id = b.service_id
     WHERE b.user_id = $1
     ORDER BY b.requested_date DESC, b.created_at DESC
     LIMIT 20;`,
    [customerId]
  );

  return {
    customer: {
      id: u.id,
      phone: u.phone,
      email: u.email,
      isActive: u.is_active,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      profile: {
        fullName: u.full_name || null,
        preferredNailShape: u.preferred_nail_shape || null,
        preferredNailLength: u.preferred_nail_length || null,
        customNailMeasurements: u.custom_nail_measurements || null,
        sizingPreset: u.sizing_preset || null,
        allergiesOrNotes: u.allergies_or_notes || null,
      },
      addresses: addressesRes.rows.map((a) => ({
        id: a.id,
        recipientName: a.recipient_name,
        recipientPhone: a.recipient_phone,
        addressLine1: a.address_line1,
        addressLine2: a.address_line2,
        landmark: a.landmark,
        city: a.city,
        state: a.state,
        postalCode: a.postal_code,
        isDefaultShipping: a.is_default_shipping,
        isDefaultService: a.is_default_service,
        isDefault: a.is_default_shipping,
        createdAt: a.created_at,
      })),
      orders: ordersRes.rows.map((o) => ({
        id: o.id,
        orderNumber: o.order_number,
        orderStatus: o.order_status,
        paymentStatus: o.payment_status,
        fulfilmentStatus: o.fulfilment_status,
        totalAmount: parseFloat(o.total_amount) || 0,
        createdAt: o.created_at,
      })),
      bookings: bookingsRes.rows.map((b) => ({
        id: b.id,
        bookingNumber: b.booking_number,
        serviceId: b.service_id,
        serviceName: b.service_name || b.service_id,
        requestedDate: b.requested_date instanceof Date ? b.requested_date.toISOString().slice(0, 10) : b.requested_date,
        requestedTimeSlot: b.requested_time_slot,
        bookingStatus: b.booking_status,
        estimatedTotal: b.estimated_total ? parseFloat(b.estimated_total) : null,
        createdAt: b.created_at,
      })),
    },
  };
}

/**
 * Lists catalog products with categories, variants, and primary image.
 *
 * @param {object} [options] { category, search, limit, offset }
 * @returns {Promise<{ products: Array<object>, total: number }>}
 */
async function listAdminProducts({ category = null, search = null, limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const whereConditions = [];
  const params = [];
  let paramIdx = 1;

  if (category && typeof category === "string" && category.trim()) {
    whereConditions.push(`p.category_id = $${paramIdx++}`);
    params.push(category.trim());
  }

  if (search && typeof search === "string" && search.trim()) {
    const term = `%${search.trim()}%`;
    whereConditions.push(`(p.name ILIKE $${paramIdx} OR p.sku ILIKE $${paramIdx})`);
    params.push(term);
    paramIdx++;
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM products p ${whereClause};`,
    params
  );
  const total = countRes.rows[0] ? countRes.rows[0].total : 0;

  const productsRes = await query(
    `SELECT
       p.id,
       p.category_id,
       pc.name AS category_name,
       p.sku,
       p.name,
       p.slug,
       p.description,
       p.craftsmanship_details,
       p.base_price,
       p.is_available,
       p.is_made_to_order,
       p.created_at,
       p.updated_at,
       pi.image_url AS primary_image_url
     FROM products p
     JOIN product_categories pc ON pc.id = p.category_id
     LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_hero = TRUE
     ${whereClause}
     ORDER BY p.name ASC, p.created_at ASC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++};`,
    [...params, safeLimit, safeOffset]
  );

  // Retrieve variants for retrieved products
  const productIds = productsRes.rows.map((p) => p.id);
  const variantsByProduct = {};

  if (productIds.length > 0) {
    const variantsRes = await query(
      `SELECT product_id, shape, length, sizing_mode, price_adjustment, is_available
       FROM product_variants
       WHERE product_id = ANY($1)
       ORDER BY shape ASC, length ASC;`,
      [productIds]
    );
    for (const v of variantsRes.rows) {
      if (!variantsByProduct[v.product_id]) {
        variantsByProduct[v.product_id] = [];
      }
      variantsByProduct[v.product_id].push({
        shape: v.shape,
        length: v.length,
        sizingMode: v.sizing_mode,
        priceAdjustment: parseFloat(v.price_adjustment),
        isAvailable: v.is_available,
      });
    }
  }

  return {
    products: productsRes.rows.map((p) => ({
      id: p.id,
      sku: p.sku,
      title: p.name,
      name: p.name,
      slug: p.slug,
      categoryId: p.category_id,
      categoryName: p.category_name,
      description: p.description,
      craftsmanshipDetails: p.craftsmanship_details,
      basePrice: parseFloat(p.base_price),
      price: parseFloat(p.base_price),
      promotionalPrice: 599.00, // Festive offer active promotional price
      isAvailable: p.is_available,
      isActive: p.is_available,
      isMadeToOrder: p.is_made_to_order,
      primaryImageUrl: p.primary_image_url || null,
      variants: variantsByProduct[p.id] || [],
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    })),
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}

/**
 * Toggles product availability and logs to audit_logs.
 * Prevents modifying base prices or promotion settings to ensure promotion integrity.
 *
 * @param {string} productId
 * @param {boolean} isActive
 * @param {object} adminUser
 * @param {string|null} [ipAddress]
 * @returns {Promise<object>}
 */
async function toggleProductAvailability(productId, isActive, adminUser, ipAddress = null) {
  if (!isValidUuid(productId)) {
    const err = new Error("Invalid product ID format.");
    err.code = "INVALID_PRODUCT_ID";
    err.statusCode = 400;
    throw err;
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    const curRes = await client.query(
      `SELECT id, sku, name, is_available FROM products WHERE id = $1 FOR UPDATE;`,
      [productId]
    );

    if (curRes.rows.length === 0) {
      const err = new Error("Product not found.");
      err.code = "PRODUCT_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const current = curRes.rows[0];
    const newStatus = Boolean(isActive);

    const updateRes = await client.query(
      `UPDATE products
       SET is_available = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, sku, name, is_available, updated_at;`,
      [newStatus, productId]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (
         actor_id, actor_role, action, target_entity, target_id, diff, ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        adminUser.id,
        adminUser.roles[0] || "admin",
        "PRODUCT_AVAILABILITY_TOGGLED",
        "products",
        productId,
        JSON.stringify({ previous_is_available: current.is_available, new_is_available: newStatus, sku: current.sku }),
        formatInetIp(ipAddress),
      ]
    );

    await client.query("COMMIT;");
    return updateRes.rows[0];
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lists salon services with add-ons. Preserves NULL prices without conversion to zero.
 *
 * @returns {Promise<Array<object>>}
 */
async function listAdminServices() {
  const servicesRes = await query(
    `SELECT
       id,
       name,
       base_price,
       promotional_price,
       estimated_duration_minutes,
       description,
       is_active
     FROM services
     ORDER BY id ASC;`
  );

  const addonsRes = await query(
    `SELECT id, service_id, name, price, is_active
     FROM service_addons
     ORDER BY name ASC;`
  );

  const addonsByService = {};
  for (const a of addonsRes.rows) {
    if (!addonsByService[a.service_id]) {
      addonsByService[a.service_id] = [];
    }
    addonsByService[a.service_id].push({
      id: a.id,
      name: a.name,
      price: a.price ? parseFloat(a.price) : null,
      isActive: a.is_active,
    });
  }

  return servicesRes.rows.map((s) => ({
    id: s.id,
    name: s.name,
    basePrice: s.base_price ? parseFloat(s.base_price) : null,
    promotionalPrice: s.promotional_price ? parseFloat(s.promotional_price) : null,
    estimatedDurationMinutes: s.estimated_duration_minutes,
    description: s.description,
    isActive: s.is_active,
    addons: addonsByService[s.id] || [],
  }));
}

/**
 * Toggles salon service availability and logs to audit_logs.
 *
 * @param {string} serviceId
 * @param {boolean} isActive
 * @param {object} adminUser
 * @param {string|null} [ipAddress]
 * @returns {Promise<object>}
 */
async function toggleServiceAvailability(serviceId, isActive, adminUser, ipAddress = null) {
  if (!serviceId || typeof serviceId !== "string") {
    const err = new Error("Invalid service ID.");
    err.code = "INVALID_SERVICE_ID";
    err.statusCode = 400;
    throw err;
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    const curRes = await client.query(
      `SELECT id, name, is_active FROM services WHERE id = $1 FOR UPDATE;`,
      [serviceId]
    );

    if (curRes.rows.length === 0) {
      const err = new Error("Service not found.");
      err.code = "SERVICE_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const current = curRes.rows[0];
    const newStatus = Boolean(isActive);

    const updateRes = await client.query(
      `UPDATE services
       SET is_active = $1
       WHERE id = $2
       RETURNING id, name, is_active;`,
      [newStatus, serviceId]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (
         actor_id, actor_role, action, target_entity, target_id, diff, ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        adminUser.id,
        adminUser.roles[0] || "admin",
        "SERVICE_AVAILABILITY_TOGGLED",
        "services",
        serviceId,
        JSON.stringify({ previous_is_active: current.is_active, new_is_active: newStatus, name: current.name }),
        formatInetIp(ipAddress),
      ]
    );

    await client.query("COMMIT;");
    return updateRes.rows[0];
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lists administrative staff members, roles, display names, and permissions.
 *
 * @returns {Promise<Array<object>>}
 */
async function listStaffAccounts() {
  const staffRes = await query(
    `SELECT
       u.id,
       u.phone,
       u.email,
       u.is_active,
       u.created_at,
       ap.display_name,
       ap.is_mfa_enabled,
       ap.last_login_at
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN admin_profiles ap ON ap.user_id = u.id
     WHERE ur.role_id IN ('super_operator', 'artist_divya', 'staff_artist', 'support_staff')
     GROUP BY u.id, ap.display_name, ap.is_mfa_enabled, ap.last_login_at
     ORDER BY u.created_at ASC;`
  );

  // Retrieve roles and permissions for each staff member
  const staffList = [];
  for (const s of staffRes.rows) {
    const rolePermRes = await query(
      `SELECT r.id AS role_id, r.name AS role_name, p.id AS permission_id, p.name AS permission_name
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = $1;`,
      [s.id]
    );

    const roles = [...new Set(rolePermRes.rows.map((r) => r.role_id))];
    const permissions = [
      ...new Set([
        ...rolePermRes.rows.map((r) => r.permission_id).filter(Boolean),
        ...rolePermRes.rows.map((r) => r.permission_name).filter(Boolean),
      ]),
    ];

    staffList.push({
      userId: s.id,
      phone: s.phone,
      email: s.email,
      displayName: s.display_name || "Staff Member",
      isMfaEnabled: s.is_mfa_enabled || false,
      lastLoginAt: s.last_login_at || null,
      isActive: s.is_active,
      roles,
      permissions,
      createdAt: s.created_at,
    });
  }

  return staffList;
}

/**
 * Retrieves the full roles and permission matrix from database seeds.
 *
 * @returns {Promise<{ roles: Array<object>, allPermissions: Array<object> }>}
 */
async function getRolePermissionMatrix() {
  const [rolesRes, permsRes, mapRes] = await Promise.all([
    query(`SELECT id, name, description FROM roles ORDER BY id ASC;`),
    query(`SELECT id, name, description FROM permissions ORDER BY id ASC;`),
    query(`SELECT role_id, permission_id FROM role_permissions ORDER BY role_id, permission_id;`),
  ]);

  const permsByRole = {};
  for (const m of mapRes.rows) {
    if (!permsByRole[m.role_id]) {
      permsByRole[m.role_id] = [];
    }
    permsByRole[m.role_id].push(m.permission_id);
  }

  return {
    roles: rolesRes.rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: permsByRole[r.id] || (r.id === "super_operator" ? permsRes.rows.map((p) => p.id) : []),
    })),
    allPermissions: permsRes.rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
    })),
  };
}

/**
 * Lists business operational configuration settings from database.
 *
 * @returns {Promise<Array<object>>}
 */
async function listBusinessSettings() {
  const settingsRes = await query(
    `SELECT key, value, description, updated_at
     FROM business_settings
     ORDER BY key ASC;`
  );

  return settingsRes.rows.map((s) => ({
    key: s.key,
    value: s.value,
    description: s.description,
    updatedAt: s.updated_at,
  }));
}

/**
 * Retrieves immutable audit logs with optional actor and entity filtering.
 *
 * @param {object} [options] { limit, offset, action, targetEntity }
 * @returns {Promise<{ logs: Array<object>, total: number, limit: number, offset: number }>}
 */
async function listAuditLogs({ limit = 50, offset = 0, action = null, targetEntity = null } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const whereConditions = [];
  const params = [];
  let paramIdx = 1;

  if (action && typeof action === "string" && action.trim()) {
    whereConditions.push(`al.action = $${paramIdx++}`);
    params.push(action.trim());
  }

  if (targetEntity && typeof targetEntity === "string" && targetEntity.trim()) {
    whereConditions.push(`al.target_entity = $${paramIdx++}`);
    params.push(targetEntity.trim());
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM audit_logs al ${whereClause};`,
    params
  );
  const total = countRes.rows[0] ? countRes.rows[0].total : 0;

  const logsRes = await query(
    `SELECT
       al.id,
       al.actor_id,
       al.actor_role,
       ap.display_name AS actor_name,
       al.action,
       al.target_entity,
       al.target_id,
       al.diff,
       al.ip_address,
       al.created_at
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.actor_id
     LEFT JOIN admin_profiles ap ON ap.user_id = u.id
     ${whereClause}
     ORDER BY al.created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++};`,
    [...params, safeLimit, safeOffset]
  );

  return {
    logs: logsRes.rows.map((log) => ({
      id: log.id,
      actorId: log.actor_id,
      actorRole: log.actor_role,
      actorName: log.actor_name || null,
      action: log.action,
      targetEntity: log.target_entity,
      targetId: log.target_id,
      diff: log.diff,
      ipAddress: log.ip_address ? String(log.ip_address) : null,
      createdAt: log.created_at,
    })),
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}

module.exports = {
  formatInetIp,
  isValidUuid,
  getEnrichedOverview,
  listCustomers,
  getCustomerDetails,
  listAdminProducts,
  toggleProductAvailability,
  listAdminServices,
  toggleServiceAvailability,
  listStaffAccounts,
  getRolePermissionMatrix,
  listBusinessSettings,
  listAuditLogs,
};
