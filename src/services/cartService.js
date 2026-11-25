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
const { withTransaction } = require("../db/pool");
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

function cartSessionForClient(cart) {
  // Old account carts can still contain the original guest receipt capability.
  // Existing clients expect a session header. Account requests authenticate by user ID.
  return cart.user_id ? `account:${cart.id}` : cart.session_token;
}

function cartNotFound() {
  return Object.assign(new Error("Cart not found or session has expired."), {
    code: "CART_NOT_FOUND", statusCode: 404,
  });
}

// All callers hold this transaction until their read, mutation or checkout completes.
async function resolveCart(client, { cartId, sessionToken = null, userId = null }, { create = false, claimOnly = false } = {}) {
  if (cartId != null) {
    if (typeof cartId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(cartId)) {
      throw cartNotFound();
    }
    const result = await client.query(
      `WITH locked AS (
         SELECT * FROM carts WHERE id = $1
         AND (user_id = $2 OR (user_id IS NULL AND session_token = $3)) FOR UPDATE
       ) SELECT * FROM locked WHERE expires_at > clock_timestamp()`,
      [cartId, userId, sessionToken]
    );
    if (!result.rows.length) throw cartNotFound();
    return result.rows[0];
  }

  let ownCart;
  if (userId) {
    // Serialize creation/merge even when this buyer does not have a cart yet.
    await client.query("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [userId]);
    const result = await client.query(
      `WITH locked AS (
         SELECT * FROM carts WHERE user_id = $1 AND expires_at > clock_timestamp()
         ORDER BY updated_at DESC, id LIMIT 1 FOR UPDATE
       ) SELECT * FROM locked WHERE expires_at > clock_timestamp()`, [userId]
    );
    ownCart = result.rows[0];
    if (ownCart && (ownCart.session_token === sessionToken || cartSessionForClient(ownCart) === sessionToken)) return ownCart;
  }

  if (sessionToken) {
    const result = await client.query(
      `WITH locked AS (
         SELECT * FROM carts WHERE user_id IS NULL AND session_token = $1 FOR UPDATE
       ) SELECT * FROM locked WHERE expires_at > clock_timestamp()`, [sessionToken]
    );
    const guestCart = result.rows[0];
    if (guestCart) {
      if (!userId) return guestCart;
      if (ownCart) return mergeGuestItems(client, guestCart, ownCart);
      // Other devices on this account must never receive the guest receipt capability.
      const assigned = await client.query(
        `UPDATE carts SET user_id = $1, session_token = $2,
           expires_at = CURRENT_TIMESTAMP + $3 * INTERVAL '1 day'
         WHERE id = $4 AND user_id IS NULL RETURNING *`,
        [userId, crypto.randomUUID(), USER_CART_EXPIRY_DAYS, guestCart.id]
      );
      return assigned.rows[0];
    }
  }

  if (claimOnly) return null;
  if (ownCart) return ownCart;
  if (!create) throw cartNotFound();
  const result = await client.query(
    `INSERT INTO carts (user_id, session_token, expires_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP + $3 * INTERVAL '1 day') RETURNING *`,
    [userId, crypto.randomUUID(), userId ? USER_CART_EXPIRY_DAYS : GUEST_CART_EXPIRY_DAYS]
  );
  return result.rows[0];
}

function getOrCreateCart(sessionToken, userId = null) {
  return withTransaction((client) => resolveCart(client, { sessionToken, userId }, { create: true }));
}

function withCart(context, operation) {
  return withTransaction(async (client) => {
    const cart = await resolveCart(client, context, { create: true });
    return operation(client, cart);
  });
}

async function touchCart(client, cartId) {
  const result = await client.query(
    "UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *", [cartId]
  );
  return result.rows[0];
}

/**
 * Retrieves full cart details including server-priced items, images, and totals.
 *
 * @param {string} cartId Cart UUID
 * @returns {Promise<object>}
 */
async function readCartDetails(client, cart) {
  const cartId = cart.id;
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
      sessionToken: cartSessionForClient(cart),
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
async function addItemToCart(client, cart, itemData) {
  const cartId = cart.id;
  const { sku } = itemData;
  if (!sku || typeof sku !== "string") {
    const err = new Error("A valid product SKU is required.");
    err.code = "SKU_REQUIRED";
    err.statusCode = 400;
    throw err;
  }

  // Verify product exists and is available
  const productRes = await client.query(
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
  const existingRes = await client.query(
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

    await client.query(
      `UPDATE cart_items SET quantity = $1 WHERE id = $2;`,
      [newQty, existingItem.id]
    );
  } else {
    await client.query(
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

  return readCartDetails(client, await touchCart(client, cartId));
}

/**
 * Updates an existing cart item's quantity or sizing.
 *
 * @param {string} cartId Cart UUID
 * @param {string} itemId Cart Item UUID
 * @param {object} updateData { quantity, shape, length, sizing_preset, custom_measurements }
 * @returns {Promise<object>} Full updated cart details
 */
async function updateCartItem(client, cart, itemId, updateData) {
  const cartId = cart.id;
  const itemRes = await client.query(
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

  await client.query(
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

  return readCartDetails(client, await touchCart(client, cartId));
}

/**
 * Removes an item from the cart.
 *
 * @param {string} cartId Cart UUID
 * @param {string} itemId Cart Item UUID
 * @returns {Promise<object>} Full updated cart details
 */
async function removeCartItem(client, cart, itemId) {
  const cartId = cart.id;
  const itemRes = await client.query(
    `SELECT id FROM cart_items WHERE id = $1 AND cart_id = $2;`,
    [itemId, cartId]
  );

  if (itemRes.rows.length === 0) {
    const err = new Error("Cart item not found in current cart session.");
    err.code = "ITEM_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  await client.query(
    `DELETE FROM cart_items WHERE id = $1 AND cart_id = $2;`,
    [itemId, cartId]
  );

  return readCartDetails(client, await touchCart(client, cartId));
}

/**
 * Clears all items from the cart.
 *
 * @param {string} cartId Cart UUID
 * @returns {Promise<object>} Full updated cart details
 */
async function clearCart(client, cart) {
  const cartId = cart.id;
  await client.query(
    `DELETE FROM cart_items WHERE cart_id = $1;`,
    [cartId]
  );

  return readCartDetails(client, await touchCart(client, cartId));
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
async function claimGuestCart(sessionToken, userId, { withDetails = false } = {}) {
  if (!sessionToken || !userId) return null;
  return withTransaction(async (client) => {
    const cart = await resolveCart(client, { sessionToken, userId }, { claimOnly: true });
    return cart && withDetails ? readCartDetails(client, cart) : cart;
  });
}

async function mergeGuestItems(client, guestCart, userCart) {
  const guestItemsRes = await client.query(
    `SELECT * FROM cart_items WHERE cart_id = $1;`,
    [guestCart.id]
  );

  for (const item of guestItemsRes.rows) {
    // Look for exact match in user cart
    const exactMatch = await client.query(
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
      await client.query(
        `UPDATE cart_items SET quantity = $1 WHERE id = $2;`,
        [combinedQty, existing.id]
      );
    } else {
      // Transfer line item to user cart as distinct row
      await client.query(
        `UPDATE cart_items SET cart_id = $1 WHERE id = $2;`,
        [userCart.id, item.id]
      );
    }
  }

  // Delete the emptied guest cart
  await client.query(`DELETE FROM carts WHERE id = $1;`, [guestCart.id]);

  return touchCart(client, userCart.id);
}

module.exports = {
  ALLOWED_SHAPES,
  ALLOWED_LENGTHS,
  ALLOWED_PRESETS,
  MAX_ITEM_QUANTITY,
  validateQuantity,
  validateSizing,
  getOrCreateCart,
  resolveCart,
  getCartDetails: (context) => withCart(context, readCartDetails),
  addItemToCart: (context, item) => withCart(context, (client, cart) => addItemToCart(client, cart, item)),
  updateCartItem: (context, id, data) => withCart(context, (client, cart) => updateCartItem(client, cart, id, data)),
  removeCartItem: (context, id) => withCart(context, (client, cart) => removeCartItem(client, cart, id)),
  clearCart: (context) => withCart(context, clearCart),
  claimGuestCart,
};
