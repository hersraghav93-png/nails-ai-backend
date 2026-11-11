/**
 * ==========================================================================
 * ADMINISTRATOR ROUTER (`src/routes/adminRoute.js`)
 * Nails by Divya Platform
 *
 * Provides protected administrative endpoints:
 * - GET /api/admin/me       -> Admin identity, role assignments, and permissions
 * - GET /api/admin/overview -> High-level operational metrics and system stats
 * ==========================================================================
 */

const express = require("express");
const { requireAuth, requireRole, requirePermission } = require("../middleware/auth");
const { query } = require("../db/pool");
const {
  adminListOrders,
  adminUpdateOrderStatus,
  getOrderById,
} = require("../services/orderService");

const router = express.Router();

// Base middleware for all admin endpoints: Must be authenticated and hold an admin role
router.use(requireAuth);
router.use(requireRole(["super_operator", "artist_divya", "staff_artist", "support_staff"]));

/**
 * GET /api/admin/me
 * Returns authenticated administrator's credentials, active roles, and granted permissions.
 */
router.get("/me", (req, res) => {
  res.json({
    status: "success",
    admin: {
      userId: req.user.id,
      firebaseUid: req.user.firebase_uid,
      phone: req.user.phone,
      displayName: req.user.adminProfile ? req.user.adminProfile.display_name : null,
      isMfaEnabled: req.user.adminProfile ? req.user.adminProfile.is_mfa_enabled : false,
      roles: req.user.roles,
      permissions: req.user.permissions,
      isActive: req.user.is_active,
    },
  });
});

/**
 * GET /api/admin/overview
 * Requires 'catalog:view' permission (super_operator, artist_divya, staff_artist).
 * Returns real-time platform metrics from PostgreSQL.
 */
router.get("/overview", requirePermission("catalog:view"), async (req, res) => {
  try {
    const [
      usersCountRes,
      productsCountRes,
      servicesCountRes,
      ordersCountRes,
      bookingsCountRes,
      designsCountRes,
    ] = await Promise.all([
      query(`SELECT COUNT(*)::int AS count FROM users;`),
      query(`SELECT COUNT(*)::int AS count FROM products;`),
      query(`SELECT COUNT(*)::int AS count FROM services;`),
      query(`SELECT COUNT(*)::int AS count FROM orders;`),
      query(`SELECT COUNT(*)::int AS count FROM bookings;`),
      query(`SELECT COUNT(*)::int AS count FROM portfolio_designs;`),
    ]);

    res.json({
      status: "success",
      overview: {
        totalUsers: usersCountRes.rows[0].count,
        totalProducts: productsCountRes.rows[0].count,
        totalServices: servicesCountRes.rows[0].count,
        totalOrders: ordersCountRes.rows[0].count,
        totalBookings: bookingsCountRes.rows[0].count,
        totalPortfolioDesigns: designsCountRes.rows[0].count,
      },
      requestedBy: {
        userId: req.user.id,
        role: req.user.roles[0] || null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ [Admin Overview Error]:", err.message);
    res.status(500).json({
      error: "Failed to retrieve administrative overview metrics.",
      code: "METRICS_FETCH_ERROR",
    });
  }
});

/**
 * GET /api/admin/orders
 * Requires 'View Orders' permission.
 * Lists orders with filtering, pagination, and customer info.
 */
router.get("/orders", requirePermission("View Orders"), async (req, res) => {
  try {
    const result = await adminListOrders({
      status: req.query.status,
      paymentStatus: req.query.payment_status,
      fulfilmentStatus: req.query.fulfilment_status,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to list orders.",
      code: err.code || "ADMIN_ORDER_LIST_FAILED",
    });
  }
});

/**
 * GET /api/admin/orders/:orderId
 * Requires 'View Orders' permission.
 * Retrieves full order details, line items, and complete status history.
 */
router.get("/orders/:orderId", requirePermission("View Orders"), async (req, res) => {
  try {
    const orderDetails = await getOrderById(req.params.orderId, {
      isAdmin: true,
      skipAuthCheck: true,
    });

    return res.json({
      status: "success",
      ...orderDetails,
    });
  } catch (err) {
    const status = err.statusCode || 404;
    return res.status(status).json({
      error: err.message || "Failed to retrieve order.",
      code: err.code || "ADMIN_ORDER_FETCH_FAILED",
    });
  }
});

/**
 * PATCH /api/admin/orders/:orderId/status
 * Requires 'Update Order Fulfillment' permission.
 * Updates order and/or fulfilment status, writes audit log, and records status history.
 */
router.patch("/orders/:orderId/status", requirePermission("Update Order Fulfillment"), async (req, res) => {
  try {
    const updated = await adminUpdateOrderStatus(
      req.params.orderId,
      {
        orderStatus: req.body && req.body.order_status,
        fulfilmentStatus: req.body && req.body.fulfilment_status,
        notes: req.body && req.body.notes,
      },
      req.user,
      req.ip
    );

    return res.json({
      status: "success",
      message: "Order status updated successfully.",
      ...updated,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to update order status.",
      code: err.code || "ADMIN_ORDER_UPDATE_FAILED",
    });
  }
});

module.exports = router;
