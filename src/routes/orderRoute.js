/**
 * ==========================================================================
 * ORDER ROUTER (`src/routes/orderRoute.js`)
 * Nails by Divya Platform — Phase 2A Commerce Engine
 *
 * REST API Endpoints for customer orders:
 * - POST /api/orders             -> Create order from validated cart (guest or auth)
 * - GET  /api/orders             -> Customer order history (authenticated)
 * - GET  /api/orders/:orderId    -> Order details by owner (strict cross-customer isolation)
 * - POST /api/orders/:orderId/cancel -> Cancel eligible unpaid order before production
 * ==========================================================================
 */

"use strict";

const express = require("express");
const { optionalAuth, requireAuth } = require("../middleware/auth");
const {
  createOrderFromCart,
  getOrderById,
  getCustomerOrders,
  cancelOrder,
} = require("../services/orderService");
const { getOrCreateCart } = require("../services/cartService");

const router = express.Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Helper to resolve cart session token from headers, query, or body.
 */
function resolveSessionToken(req) {
  const headerToken = req.headers["x-cart-session"];
  if (headerToken && typeof headerToken === "string") {
    return headerToken.trim();
  }
  if (req.query && req.query.session_token) {
    return req.query.session_token.trim();
  }
  if (req.body && req.body.session_token) {
    return req.body.session_token.trim();
  }
  return null;
}

/**
 * Helper to resolve idempotency key from headers or body.
 */
function resolveIdempotencyKey(req) {
  const headerKey = req.headers["idempotency-key"] || req.headers["x-idempotency-key"];
  if (headerKey && typeof headerKey === "string") {
    return headerKey.trim();
  }
  if (req.body && req.body.idempotency_key) {
    return req.body.idempotency_key.toString().trim();
  }
  return null;
}

/**
 * Helper to resolve guest claim secret from headers or query.
 */
function resolveClaimSecret(req) {
  const headerSecret = req.headers["x-claim-secret"];
  if (headerSecret && typeof headerSecret === "string") {
    return headerSecret.trim();
  }
  if (req.query && req.query.claim_secret) {
    return req.query.claim_secret.trim();
  }
  if (req.body && req.body.claim_secret) {
    return req.body.claim_secret.trim();
  }
  return null;
}

/**
 * POST /api/orders
 * Creates an order from a validated shopping cart.
 * Supports guest checkout and authenticated customer checkout.
 * Idempotency protection prevents duplicate submissions on network retries.
 */
router.post("/", optionalAuth, async (req, res) => {
  try {
    const sessionToken = resolveSessionToken(req);
    const idempotencyKey = resolveIdempotencyKey(req);
    const userId = req.user ? req.user.id : null;

    let cartId = req.body && req.body.cart_id;
    if (!cartId) {
      // Resolve cart by session token or user
      const cart = await getOrCreateCart(sessionToken, userId);
      cartId = cart.id;
    }

    const orderResult = await createOrderFromCart({
      cartId,
      sessionToken,
      userId,
      customer: req.body && req.body.customer,
      shippingAddress: req.body && (req.body.shipping_address || req.body.shippingAddress),
      customerNotes: req.body && (req.body.customer_notes || req.body.customerNotes),
      idempotencyKey,
      ipAddress: req.ip,
    });

    const statusCode = orderResult.isDuplicate ? 200 : 201;
    return res.status(statusCode).json({
      status: "success",
      message: orderResult.isDuplicate
        ? "Order retrieved from previous submission."
        : "Order successfully placed in PENDING status.",
      ...orderResult,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to create order.",
      code: err.code || "ORDER_CREATION_FAILED",
    });
  }
});

/**
 * GET /api/orders
 * Retrieves customer order history for the authenticated user.
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await getCustomerOrders(req.user.id, {
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
      error: err.message || "Failed to retrieve order history.",
      code: err.code || "ORDER_LIST_FAILED",
    });
  }
});

/**
 * GET /api/orders/:orderId
 * Retrieves detailed order information by authorized owner.
 * Strictly verifies ownership (customer userId, guest claim secret, or guest session token).
 */
router.get("/:orderId", optionalAuth, async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.orderId)) {
      return res.status(404).json({
        error: "Order not found. Invalid order identifier format.",
        code: "ORDER_NOT_FOUND",
      });
    }

    const sessionToken = resolveSessionToken(req);
    const claimSecret = resolveClaimSecret(req);
    const userId = req.user ? req.user.id : null;
    const isAdmin = Boolean(
      req.user &&
      Array.isArray(req.user.roles) &&
      req.user.roles.some((r) => ["super_operator", "artist_divya", "staff_artist", "support_staff"].includes(r))
    );

    const orderDetails = await getOrderById(req.params.orderId, {
      userId,
      sessionToken,
      claimSecret,
      isAdmin,
    });

    return res.json({
      status: "success",
      ...orderDetails,
    });
  } catch (err) {
    const status = err.statusCode || (err.code === "ORDER_NOT_FOUND" ? 404 : 403);
    return res.status(status).json({
      error: err.message || "Failed to retrieve order.",
      code: err.code || "ORDER_FETCH_FAILED",
    });
  }
});

/**
 * POST /api/orders/:orderId/cancel
 * Cancels an eligible unpaid order (must be in PENDING order_status and PENDING payment_status).
 */
router.post("/:orderId/cancel", optionalAuth, async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.orderId)) {
      return res.status(404).json({
        error: "Order not found. Invalid order identifier format.",
        code: "ORDER_NOT_FOUND",
      });
    }

    const sessionToken = resolveSessionToken(req);
    const claimSecret = resolveClaimSecret(req);
    const userId = req.user ? req.user.id : null;
    const isAdmin = Boolean(
      req.user &&
      Array.isArray(req.user.roles) &&
      req.user.roles.some((r) => ["super_operator", "artist_divya", "staff_artist"].includes(r))
    );

    const cancelledOrder = await cancelOrder(req.params.orderId, {
      userId,
      sessionToken,
      claimSecret,
      isAdmin,
      reason: req.body && req.body.reason,
    });

    return res.json({
      status: "success",
      message: "Order has been successfully cancelled.",
      ...cancelledOrder,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to cancel order.",
      code: err.code || "ORDER_CANCEL_FAILED",
    });
  }
});

module.exports = router;
