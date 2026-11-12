/**
 * ==========================================================================
 * PRICING & PROMOTION ENGINE (`src/services/pricingEngine.js`)
 * Nails by Divya Platform — Phase 2A Commerce Engine
 *
 * Provides tamper-proof server-side pricing calculations:
 * - Base price verification against PostgreSQL catalog
 * - Active promotional offer validation (Festive Offer: ₹599 for press-on sets)
 * - Safe subtotal, discount, shipping, and order grand total calculation
 * ==========================================================================
 */

"use strict";

// Festive promotion configuration (matches verified studio promotion)
const FESTIVE_PROMOTION = {
  active: true,
  promoPrice: 599.0, // ₹599.00 fixed promotional price for all eligible press-on sets
  name: "Festive Offer · ₹599",
  code: "FESTIVE_599",
};

/**
 * Validates whether a product is eligible for the promotional festive offer.
 * All available press-on nail sets (category: press-on / handmade) are eligible.
 *
 * @param {object} product Product record from database
 * @returns {boolean}
 */
function isFestiveOfferEligible(product) {
  if (!FESTIVE_PROMOTION.active) return false;
  if (!product || product.is_available === false || product.is_archived === true) {
    return false;
  }
  // Non-promotional flag: explicit opt-out
  if (product.is_promotional === false || product.is_festive_eligible === false) {
    return false;
  }
  // Category restriction: only press-on / handmade sets qualify
  const category = (product.category_id || product.category || "").toLowerCase();
  if (category && !["wedding", "party", "daily", "work", "press-on", "press_on", "presson", "handmade"].includes(category)) {
    return false;
  }
  return true;
}

/**
 * Calculates item-level pricing breakdown.
 *
 * @param {object} product Product record from database
 * @param {number} quantity Validated positive integer quantity
 * @returns {{
 *   basePrice: number,
 *   unitPrice: number,
 *   isPromoApplied: boolean,
 *   promoName: string|null,
 *   itemSubtotal: number,
 *   itemDiscount: number,
 *   itemTotal: number
 * }}
 */
function calculateItemPricing(product, quantity) {
  const basePrice = parseFloat(product.base_price);
  if (isNaN(basePrice) || basePrice < 0) {
    throw new Error(`Invalid base price for product ${product.sku || product.id}`);
  }

  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty <= 0) {
    throw new Error(`Quantity must be a positive integer, got ${quantity}`);
  }

  let unitPrice = basePrice;
  let isPromoApplied = false;
  let promoName = null;

  if (isFestiveOfferEligible(product)) {
    // If base price is higher than promo price, apply discount down to ₹599
    if (basePrice > FESTIVE_PROMOTION.promoPrice) {
      unitPrice = FESTIVE_PROMOTION.promoPrice;
      isPromoApplied = true;
      promoName = FESTIVE_PROMOTION.name;
    }
  }

  const itemSubtotal = parseFloat((basePrice * qty).toFixed(2));
  const itemTotal = parseFloat((unitPrice * qty).toFixed(2));
  const itemDiscount = parseFloat((itemSubtotal - itemTotal).toFixed(2));

  return {
    basePrice,
    unitPrice,
    isPromoApplied,
    promoName,
    itemSubtotal,
    itemDiscount,
    itemTotal,
  };
}

/**
 * Calculates order or cart totals from an array of priced items.
 *
 * @param {Array<object>} pricedItems Items calculated via calculateItemPricing
 * @param {number} [shippingFee=0.00] Shipping fee
 * @returns {{
 *   subtotal: number,
 *   discountAmount: number,
 *   shippingFee: number,
 *   totalAmount: number,
 *   currency: string,
 *   itemCount: number
 * }}
 */
function calculateCartTotals(pricedItems, shippingFee = 0.0) {
  let subtotal = 0;
  let discountAmount = 0;
  let totalAmount = 0;
  let itemCount = 0;

  for (const item of pricedItems) {
    subtotal += item.itemSubtotal || 0;
    discountAmount += item.itemDiscount || 0;
    totalAmount += item.itemTotal || 0;
    itemCount += item.quantity || 1;
  }

  const fee = parseFloat(Number(shippingFee || 0).toFixed(2));
  const finalTotal = parseFloat((totalAmount + fee).toFixed(2));

  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    discountAmount: parseFloat(discountAmount.toFixed(2)),
    shippingFee: fee,
    totalAmount: finalTotal,
    currency: "INR",
    itemCount,
  };
}

module.exports = {
  FESTIVE_PROMOTION,
  isFestiveOfferEligible,
  calculateItemPricing,
  calculateCartTotals,
};
