/**
 * ==========================================================================
 * CART ROUTER (`src/routes/cartRoute.js`)
 * Nails by Divya Platform — Phase 2A Commerce Engine
 *
 * REST API Endpoints for shopping cart management:
 * - GET    /api/cart            -> Retrieve or initialize cart
 * - POST   /api/cart/items      -> Add item to cart (server-side SKU & sizing validation)
 * - PUT    /api/cart/items/:id  -> Update quantity or sizing
 * - DELETE /api/cart/items/:id  -> Remove item from cart
 * - DELETE /api/cart            -> Clear entire cart
 * - POST   /api/cart/claim      -> Associate guest cart with authenticated customer
 * ==========================================================================
 */

"use strict";

const express = require("express");
const { optionalAuth, requireAuth } = require("../middleware/auth");
const {
  getOrCreateCart,
  getCartDetails,
  addItemToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
  claimGuestCart,
} = require("../services/cartService");

const router = express.Router();

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
 * GET /api/cart
 * Retrieves or initializes active cart for guest or authenticated customer.
 */
router.get("/", optionalAuth, async (req, res) => {
  try {
    const sessionToken = resolveSessionToken(req);
    const userId = req.user ? req.user.id : null;

    const cart = await getOrCreateCart(sessionToken, userId);
    const details = await getCartDetails(cart.id);

    res.setHeader("X-Cart-Session", details.cart.sessionToken);
    return res.json({
      status: "success",
      ...details,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to retrieve cart.",
      code: err.code || "CART_ERROR",
    });
  }
});

/**
 * POST /api/cart/items
 * Adds a verified product SKU with shape, length, sizing preset, and quantity to the cart.
 */
router.post("/items", optionalAuth, async (req, res) => {
  try {
    const sessionToken = resolveSessionToken(req);
    const userId = req.user ? req.user.id : null;

    const cart = await getOrCreateCart(sessionToken, userId);
    const updatedDetails = await addItemToCart(cart.id, req.body || {});

    res.setHeader("X-Cart-Session", updatedDetails.cart.sessionToken);
    return res.status(201).json({
      status: "success",
      message: "Item added to cart.",
      ...updatedDetails,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to add item to cart.",
      code: err.code || "CART_ADD_ERROR",
    });
  }
});

/**
 * PUT /api/cart/items/:itemId
 * Updates item quantity and/or sizing.
 */
router.put("/items/:itemId", optionalAuth, async (req, res) => {
  try {
    const sessionToken = resolveSessionToken(req);
    const userId = req.user ? req.user.id : null;

    const cart = await getOrCreateCart(sessionToken, userId);
    const updatedDetails = await updateCartItem(cart.id, req.params.itemId, req.body || {});

    res.setHeader("X-Cart-Session", updatedDetails.cart.sessionToken);
    return res.json({
      status: "success",
      message: "Cart item updated.",
      ...updatedDetails,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to update cart item.",
      code: err.code || "CART_UPDATE_ERROR",
    });
  }
});

/**
 * DELETE /api/cart/items/:itemId
 * Removes an item from the active cart.
 */
router.delete("/items/:itemId", optionalAuth, async (req, res) => {
  try {
    const sessionToken = resolveSessionToken(req);
    const userId = req.user ? req.user.id : null;

    const cart = await getOrCreateCart(sessionToken, userId);
    const updatedDetails = await removeCartItem(cart.id, req.params.itemId);

    res.setHeader("X-Cart-Session", updatedDetails.cart.sessionToken);
    return res.json({
      status: "success",
      message: "Item removed from cart.",
      ...updatedDetails,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to remove item from cart.",
      code: err.code || "CART_REMOVE_ERROR",
    });
  }
});

/**
 * DELETE /api/cart
 * Clears all items from the active cart.
 */
router.delete("/", optionalAuth, async (req, res) => {
  try {
    const sessionToken = resolveSessionToken(req);
    const userId = req.user ? req.user.id : null;

    const cart = await getOrCreateCart(sessionToken, userId);
    const updatedDetails = await clearCart(cart.id);

    res.setHeader("X-Cart-Session", updatedDetails.cart.sessionToken);
    return res.json({
      status: "success",
      message: "Cart cleared.",
      ...updatedDetails,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to clear cart.",
      code: err.code || "CART_CLEAR_ERROR",
    });
  }
});

/**
 * POST /api/cart/claim
 * Requires authentication. Associates an existing guest cart session with the logged-in customer.
 */
router.post("/claim", requireAuth, async (req, res) => {
  try {
    const guestSessionToken =
      (req.body && req.body.guest_session_token) || resolveSessionToken(req);

    if (!guestSessionToken) {
      return res.status(400).json({
        error: "Guest session token is required to claim cart.",
        code: "GUEST_SESSION_REQUIRED",
      });
    }

    const claimedCart = await claimGuestCart(guestSessionToken, req.user.id);
    if (!claimedCart) {
      return res.status(404).json({
        error: "Guest cart not found or already claimed.",
        code: "GUEST_CART_NOT_FOUND",
      });
    }

    const details = await getCartDetails(claimedCart.id);
    res.setHeader("X-Cart-Session", details.cart.sessionToken);

    return res.json({
      status: "success",
      message: "Guest cart successfully associated with customer account.",
      ...details,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to claim guest cart.",
      code: err.code || "CART_CLAIM_ERROR",
    });
  }
});

module.exports = router;
