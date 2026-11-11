/**
 * ==========================================================================
 * CART SERVICE (`src/services/cartService.js`)
 * Nails by Divya Platform — Phase 2A Commerce Engine
 *
 * Provides business logic and database interactions for shopping carts:
 * - Guest and authenticated customer cart resolution
 * - Server-side SKU, sizing, and quantity validation
 * - Tamper-proof pricing recalculations
 * - Safe guest-to-customer cart claim & ownership transfer
 * ==========================================================================
 */

"use strict";

const crypto = require("crypto");
const { query } = require("../db/pool");
const { calculateItemPricing, calculateCartTotals } = require("./pricingEngine");

// Catalog shape, length, and preset specifications
const ALLOWED_SHAPES = [
  "Almond",
  "Square",
  "Coffin",
  "Stiletto",
  "Oval",
  "Round",
  "Squoval",
  "Ballerina",
];

const ALLOWED_LENGTHS = [
  "Extra Short",
  "Short",
  "Medium",
  "Long",
  "Extra Long",
];

const ALLOWED_PRESETS = ["XS", "S", "M", "L", "Custom"];

const GUEST_CART_EXPIRY_DAYS = 7;
const USER_CART_EXPIRY_DAYS = 14;
const MAX_ITEM_QUANTITY = 20;

/**
 * Validates and normalizes quantity.
 * @param {any} qty
 * @returns {number}
 */
function validateQuantity(qty) {
  const parsed = parseInt(qty, 10);
  if (isNaN(parsed) || parsed < 1) {
    const err = new Error("Item quantity must be a positive integer of at least 1.");
    err.code = "INVALID_QUANTITY";
    err.statusCode = 400;
    throw err;
  }
  if (parsed > MAX_ITEM_QUANTITY) {
    const err = new Error(`Item quantity cannot exceed ${MAX_ITEM_QUANTITY} units per line item.`);
    err.code = "EXCEEDS_MAX_QUANTITY";
    err.statusCode = 400;
    throw err;
  }
  return parsed;
}

/**
 * Validates sizing configuration (shape, length, preset, measurements).
 */
function validateSizing({ shape, length, sizing_preset, custom_measurements }) {
  if (!shape || !ALLOWED_SHAPES.includes(shape)) {
    const err = new Error(
      `Invalid nail shape '${shape}'. Allowed shapes: ${ALLOWED_SHAPES.join(", ")}.`
    );
    err.code = "INVALID_SHAPE";
    err.statusCode = 400;
    throw err;
  }

  if (!length || !ALLOWED_LENGTHS.includes(length)) {
    const err = new Error(
      `Invalid nail length '${length}'. Allowed lengths: ${ALLOWED_LENGTHS.join(", ")}.`
    );
    err.code = "INVALID_LENGTH";
    err.statusCode = 400;
    throw err;
  }

  const preset = sizing_preset || "M";
  if (!ALLOWED_PRESETS.includes(preset)) {
    const err = new Error(
      `Invalid sizing preset '${preset}'. Allowed presets: ${ALLOWED_PRESETS.join(", ")}.`
    );
    err.code = "INVALID_PRESET";
    err.statusCode = 400;
    throw err;
  }

  let normalizedMeasurements = null;
  if (preset === "Custom" || custom_measurements) {
    if (custom_measurements && typeof custom_measurements === "object") {
      normalizedMeasurements = {};
      const fingers = ["thumb", "index", "middle", "ring", "pinky"];
      for (const f of fingers) {
        if (custom_measurements[f] !== undefined) {
          const val = parseFloat(custom_measurements[f]);
          if (!isNaN(val) && val >= 6 && val <= 25) {
            normalizedMeasurements[f] = val;
          }
        }
      }
      if (typeof custom_measurements.notes === "string") {
        normalizedMeasurements.notes = custom_measurements.notes.substring(0, 255);
      }
    }
  }

  return {
    shape,
    length,
    sizing_preset: preset,
    custom_measurements: normalizedMeasurements,
  };
}

/**
 * Retrieves or creates a shopping cart.
 *
 * @param {string|null} sessionToken Client session token (guest or user)
 * @param {string|null} userId Authenticated user UUID
 * @returns {Promise<object>} Active cart row
 */
async function getOrCreateCart(sessionToken, userId = null) {
  // 1. If user is authenticated, look for active user cart first
  if (userId) {
    const userCartRes = await query(
      `SELECT * FROM carts 
       WHERE user_id = $1 AND expires_at > CURRENT_TIMESTAMP 
       ORDER BY updated_at DESC LIMIT 1;`,
      [userId]
    );

    if (userCartRes.rows.length > 0) {
      const userCart = userCartRes.rows[0];

      // If a distinct guest session token was also supplied, claim/merge items into user cart
      if (sessionToken && sessionToken !== userCart.session_token) {
        await claimGuestCart(sessionToken, userId);
      }

      return userCart;
    }
  }

  // 2. Look for existing cart by session token
  if (sessionToken) {
    const cartRes = await query(
      `SELECT * FROM carts 
       WHERE session_token = $1 AND expires_at > CURRENT_TIMESTAMP;`,
      [sessionToken]
    );

    if (cartRes.rows.length > 0) {
      const cart = cartRes.rows[0];

      // Link guest cart to user if user just logged in
      if (userId && !cart.user_id) {
        const updatedRes = await query(
          `UPDATE carts 
           SET user_id = $1, expires_at = CURRENT_TIMESTAMP + ($2 || ' days')::INTERVAL, updated_at = CURRENT_TIMESTAMP 
           WHERE id = $3 
           RETURNING *;`,
          [userId, USER_CART_EXPIRY_DAYS, cart.id]
        );
        return updatedRes.rows[0];
      }

      return cart;
    }
  }

  // 3. Create a new cart
  const newSessionToken = sessionToken && !sessionToken.includes(" ") ? sessionToken : crypto.randomUUID();
  const expiryDays = userId ? USER_CART_EXPIRY_DAYS : GUEST_CART_EXPIRY_DAYS;

  const insertRes = await query(
    `INSERT INTO carts (user_id, session_token, expires_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP + ($3 || ' days')::INTERVAL)
     RETURNING *;`,
    [userId, newSessionToken, expiryDays]
  );

  return insertRes.rows[0];
}

/**
 * Retrieves full cart details including server-priced items, images, and totals.
 *
 * @param {string} cartId Cart UUID
 * @returns {Promise<object>}
 */
async function getCartDetails(cartId) {
  const cartRes = await query(
    `SELECT * FROM carts WHERE id = $1;`,
    [cartId]
  );

  if (cartRes.rows.length === 0) {
    const err = new Error("Cart not found or session has expired.");
    err.code = "CART_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const cart = cartRes.rows[0];

  const itemsRes = await query(
    `SELECT 
       ci.id,
       ci.cart_id,
       ci.product_id,
       ci.shape,
       ci.length,
       ci.sizing_preset,
       ci.custom_measurements,
       ci.quantity,
       ci.created_at,
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

  const pricedItems = [];
  for (const row of itemsRes.rows) {
    const pricing = calculateItemPricing(row, row.quantity);
    pricedItems.push({
      id: row.id,
      cartId: row.cart_id,
      productId: row.product_id,
      sku: row.sku,
      productName: row.product_name,
      heroImageUrl: row.hero_image_url,
      shape: row.shape,
      length: row.length,
      sizingPreset: row.sizing_preset,
      customMeasurements: row.custom_measurements,
      quantity: row.quantity,
      basePrice: pricing.basePrice,
      unitPrice: pricing.unitPrice,
      isPromoApplied: pricing.isPromoApplied,
      promoName: pricing.promoName,
      itemSubtotal: pricing.itemSubtotal,
      itemDiscount: pricing.itemDiscount,
      itemTotal: pricing.itemTotal,
      isAvailable: row.is_available && !row.is_archived,
      createdAt: row.created_at,
    });
  }

  const totals = calculateCartTotals(pricedItems);

  return {
    cart: {
      id: cart.id,
      userId: cart.user_id,
      sessionToken: cart.session_token,
      expiresAt: cart.expires_at,
      updatedAt: cart.updated_at,
    },
    items: pricedItems,
    totals,
  };
}

/**
 * Adds an item to the cart.
 *
 * @param {string} cartId Cart UUID
 * @param {object} itemData { sku, shape, length, sizing_preset, custom_measurements, quantity }
 * @returns {Promise<object>} Full updated cart details
 */
async function addItemToCart(cartId, itemData) {
  const { sku } = itemData;
  if (!sku || typeof sku !== "string") {
    const err = new Error("A valid product SKU is required.");
    err.code = "SKU_REQUIRED";
    err.statusCode = 400;
    throw err;
  }

  // Verify product exists and is available
  const productRes = await query(
    `SELECT * FROM products 
     WHERE (UPPER(sku) = UPPER($1) OR id::text = $1) AND is_archived = FALSE;`,
    [sku.trim()]
  );

  if (productRes.rows.length === 0) {
    const err = new Error(`Product SKU '${sku}' does not exist.`);
    err.code = "INVALID_SKU";
    err.statusCode = 400;
    throw err;
  }

  const product = productRes.rows[0];
  if (!product.is_available) {
    const err = new Error(`Product '${product.name}' (${product.sku}) is currently unavailable.`);
    err.code = "PRODUCT_UNAVAILABLE";
    err.statusCode = 400;
    throw err;
  }

  const quantity = validateQuantity(
    itemData.quantity !== undefined ? itemData.quantity : 1
  );
  const sizing = validateSizing(itemData);

  // Check if an identical item already exists in the cart (same product, shape, length, preset, measurements)
  const existingRes = await query(
    `SELECT * FROM cart_items 
     WHERE cart_id = $1 
       AND product_id = $2 
       AND shape = $3 
       AND length = $4 
       AND sizing_preset = $5 
       AND (custom_measurements IS NOT DISTINCT FROM $6::jsonb);`,
    [
      cartId,
      product.id,
      sizing.shape,
      sizing.length,
      sizing.sizing_preset,
      sizing.custom_measurements ? JSON.stringify(sizing.custom_measurements) : null,
    ]
  );

  if (existingRes.rows.length > 0) {
    const existingItem = existingRes.rows[0];
    const newQty = existingItem.quantity + quantity;
    if (newQty > MAX_ITEM_QUANTITY) {
      const err = new Error(
        `Adding ${quantity} units would exceed maximum limit of ${MAX_ITEM_QUANTITY} units (current in cart: ${existingItem.quantity}).`
      );
      err.code = "EXCEEDS_MAX_QUANTITY";
      err.statusCode = 400;
      throw err;
    }

    await query(
      `UPDATE cart_items SET quantity = $1 WHERE id = $2;`,
      [newQty, existingItem.id]
    );
  } else {
    await query(
      `INSERT INTO cart_items (cart_id, product_id, shape, length, sizing_preset, custom_measurements, quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        cartId,
        product.id,
        sizing.shape,
        sizing.length,
        sizing.sizing_preset,
        sizing.custom_measurements ? JSON.stringify(sizing.custom_measurements) : null,
        quantity,
      ]
    );
  }

  // Touch cart timestamp
  await query(
    `UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
    [cartId]
  );

  return getCartDetails(cartId);
}

/**
 * Updates an existing cart item's quantity or sizing.
 *
 * @param {string} cartId Cart UUID
 * @param {string} itemId Cart Item UUID
 * @param {object} updateData { quantity, shape, length, sizing_preset, custom_measurements }
 * @returns {Promise<object>} Full updated cart details
 */
async function updateCartItem(cartId, itemId, updateData) {
  const itemRes = await query(
    `SELECT * FROM cart_items WHERE id = $1 AND cart_id = $2;`,
    [itemId, cartId]
  );

  if (itemRes.rows.length === 0) {
    const err = new Error("Cart item not found in current cart session.");
    err.code = "ITEM_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const currentItem = itemRes.rows[0];
  const newQty = updateData.quantity !== undefined
    ? validateQuantity(updateData.quantity)
    : currentItem.quantity;

  const newShape = updateData.shape !== undefined ? updateData.shape : currentItem.shape;
  const newLength = updateData.length !== undefined ? updateData.length : currentItem.length;
  const newPreset = updateData.sizing_preset !== undefined ? updateData.sizing_preset : currentItem.sizing_preset;
  const newMeasurements = updateData.custom_measurements !== undefined
    ? updateData.custom_measurements
    : currentItem.custom_measurements;

  const sizing = validateSizing({
    shape: newShape,
    length: newLength,
    sizing_preset: newPreset,
    custom_measurements: newMeasurements,
  });

  await query(
    `UPDATE cart_items 
     SET quantity = $1, shape = $2, length = $3, sizing_preset = $4, custom_measurements = $5
     WHERE id = $6 AND cart_id = $7;`,
    [
      newQty,
      sizing.shape,
      sizing.length,
      sizing.sizing_preset,
      sizing.custom_measurements ? JSON.stringify(sizing.custom_measurements) : null,
      itemId,
      cartId,
    ]
  );

  await query(
    `UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
    [cartId]
  );

  return getCartDetails(cartId);
}

/**
 * Removes an item from the cart.
 *
 * @param {string} cartId Cart UUID
 * @param {string} itemId Cart Item UUID
 * @returns {Promise<object>} Full updated cart details
 */
async function removeCartItem(cartId, itemId) {
  const itemRes = await query(
    `SELECT id FROM cart_items WHERE id = $1 AND cart_id = $2;`,
    [itemId, cartId]
  );

  if (itemRes.rows.length === 0) {
    const err = new Error("Cart item not found in current cart session.");
    err.code = "ITEM_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  await query(
    `DELETE FROM cart_items WHERE id = $1 AND cart_id = $2;`,
    [itemId, cartId]
  );

  await query(
    `UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
    [cartId]
  );

  return getCartDetails(cartId);
}

/**
 * Clears all items from the cart.
 *
 * @param {string} cartId Cart UUID
 * @returns {Promise<object>} Full updated cart details
 */
async function clearCart(cartId) {
  await query(
    `DELETE FROM cart_items WHERE cart_id = $1;`,
    [cartId]
  );

  await query(
    `UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
    [cartId]
  );

  return getCartDetails(cartId);
}

/**
 * Safely associates or merges a guest cart into an authenticated customer's cart.
 * Conflicting line items with different sizing or custom measurements are kept
 * as distinct rows and never silently collapsed.
 *
 * @param {string} guestSessionToken Guest cart session token
 * @param {string} userId Authenticated user UUID
 * @returns {Promise<object|null>}
 */
async function claimGuestCart(guestSessionToken, userId) {
  if (!guestSessionToken || !userId) return null;

  const guestCartRes = await query(
    `SELECT * FROM carts 
     WHERE session_token = $1 AND expires_at > CURRENT_TIMESTAMP;`,
    [guestSessionToken]
  );

  if (guestCartRes.rows.length === 0) return null;
  const guestCart = guestCartRes.rows[0];

  // If the guest cart already belongs to this user, nothing to do
  if (guestCart.user_id === userId) return guestCart;

  // Check if user already has an active user cart
  const userCartRes = await query(
    `SELECT * FROM carts 
     WHERE user_id = $1 AND expires_at > CURRENT_TIMESTAMP 
     ORDER BY updated_at DESC LIMIT 1;`,
    [userId]
  );

  if (userCartRes.rows.length === 0) {
    // User has no cart: assign guest cart directly to user
    const updated = await query(
      `UPDATE carts 
       SET user_id = $1, expires_at = CURRENT_TIMESTAMP + ($2 || ' days')::INTERVAL, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3 
       RETURNING *;`,
      [userId, USER_CART_EXPIRY_DAYS, guestCart.id]
    );
    return updated.rows[0];
  }

  // User has an existing cart: transfer guest items safely
  const userCart = userCartRes.rows[0];
  if (userCart.id === guestCart.id) return userCart;

  const guestItemsRes = await query(
    `SELECT * FROM cart_items WHERE cart_id = $1;`,
    [guestCart.id]
  );

  for (const item of guestItemsRes.rows) {
    // Look for exact match in user cart
    const exactMatch = await query(
      `SELECT * FROM cart_items 
       WHERE cart_id = $1 
         AND product_id = $2 
         AND shape = $3 
         AND length = $4 
         AND sizing_preset = $5 
         AND (custom_measurements IS NOT DISTINCT FROM $6::jsonb);`,
      [
        userCart.id,
        item.product_id,
        item.shape,
        item.length,
        item.sizing_preset,
        item.custom_measurements ? JSON.stringify(item.custom_measurements) : null,
      ]
    );

    if (exactMatch.rows.length > 0) {
      // Increment quantity without exceeding limit
      const existing = exactMatch.rows[0];
      const combinedQty = Math.min(existing.quantity + item.quantity, MAX_ITEM_QUANTITY);
      await query(
        `UPDATE cart_items SET quantity = $1 WHERE id = $2;`,
        [combinedQty, existing.id]
      );
    } else {
      // Transfer line item to user cart as distinct row
      await query(
        `UPDATE cart_items SET cart_id = $1 WHERE id = $2;`,
        [userCart.id, item.id]
      );
    }
  }

  // Delete the emptied guest cart
  await query(`DELETE FROM carts WHERE id = $1;`, [guestCart.id]);

  await query(
    `UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
    [userCart.id]
  );

  return userCart;
}

module.exports = {
  ALLOWED_SHAPES,
  ALLOWED_LENGTHS,
  ALLOWED_PRESETS,
  MAX_ITEM_QUANTITY,
  validateQuantity,
  validateSizing,
  getOrCreateCart,
  getCartDetails,
  addItemToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
  claimGuestCart,
};
