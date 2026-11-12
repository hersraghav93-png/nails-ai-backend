/**
 * ==========================================================================
 * REVIEW SERVICE (`src/services/reviewService.js`)
 * Nails by Divya Platform — Genuine Customer Feedback & Moderation
 *
 * Implements:
 * - Public review submission with unapproved default state (is_approved = FALSE)
 * - Public list of approved genuine client reviews
 * - Administrative review moderation (approve, reject, add internal notes)
 * - Audit logging for all administrative review moderation actions
 * ==========================================================================
 */

"use strict";

const { query } = require("../db/pool");

function formatInetIp(ip) {
  if (!ip || typeof ip !== "string") return null;
  const clean = ip.replace(/^::ffff:/, "").trim();
  if (clean === "::1" || clean === "127.0.0.1") return "127.0.0.1";
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return clean;
  if (clean.includes(":")) return clean;
  return null;
}

function isValidUuid(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function normalizePhoneDigits(phone) {
  if (!phone || typeof phone !== "string") return "";
  const digits = phone.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Submits genuine customer feedback.
 * All submissions are stored with is_approved = FALSE by default.
 *
 * @param {object} reviewData
 * @returns {Promise<object>} Created review
 */
async function submitCustomerReview(reviewData) {
  const {
    customerName,
    customer_name,
    customerPhone,
    customer_phone,
    customerEmail,
    customer_email,
    rating,
    title,
    reviewText,
    review_text,
    serviceOrProductTag,
    service_or_product_tag,
    orderId,
    order_id,
    bookingId,
    booking_id,
    source = "storefront",
  } = reviewData || {};

  const name = (customerName || customer_name || "").trim();
  const text = (reviewText || review_text || "").trim();
  const phone = customerPhone || customer_phone ? String(customerPhone || customer_phone).trim() : null;
  const email = customerEmail || customer_email ? String(customerEmail || customer_email).trim() : null;
  const revTitle = title ? String(title).trim() : null;
  const tag = serviceOrProductTag || service_or_product_tag ? String(serviceOrProductTag || service_or_product_tag).trim() : null;
  const ordId = orderId || order_id || null;
  const bkgId = bookingId || booking_id || null;

  if (!name || name.length < 2) {
    const err = new Error("Customer name is required (minimum 2 characters).");
    err.code = "INVALID_REVIEW_NAME";
    err.statusCode = 400;
    throw err;
  }

  const numRating = parseInt(rating, 10);
  if (isNaN(numRating) || numRating < 1 || numRating > 5) {
    const err = new Error("Rating must be an integer between 1 and 5.");
    err.code = "INVALID_REVIEW_RATING";
    err.statusCode = 400;
    throw err;
  }

  if (!text || text.length < 10) {
    const err = new Error("Review feedback text is required (minimum 10 characters).");
    err.code = "INVALID_REVIEW_TEXT";
    err.statusCode = 400;
    throw err;
  }

  // 1. Validate Order linkage & Ownership Verification (if provided)
  let verifiedOrderId = null;
  if (ordId) {
    if (!isValidUuid(ordId)) {
      const err = new Error("Invalid order ID format. Must be a valid UUID.");
      err.code = "INVALID_ORDER_ID";
      err.statusCode = 400;
      throw err;
    }
    const orderRes = await query(
      `SELECT id, order_status, fulfilment_status, customer_phone, customer_email FROM orders WHERE id = $1;`,
      [ordId]
    );
    if (orderRes.rows.length === 0) {
      const err = new Error("Referenced order does not exist.");
      err.code = "ORDER_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }
    const order = orderRes.rows[0];
    if (order.fulfilment_status !== "DELIVERED" && order.order_status !== "COMPLETED") {
      const err = new Error("Reviews can only be submitted for delivered press-on orders.");
      err.code = "ORDER_NOT_ELIGIBLE_FOR_REVIEW";
      err.statusCode = 400;
      throw err;
    }

    // Security Guard: Submitter must provide contact info matching the order record
    const submitterPhoneDigits = normalizePhoneDigits(phone);
    const orderPhoneDigits = normalizePhoneDigits(order.customer_phone);
    const submitterEmailNorm = email ? email.toLowerCase().trim() : "";
    const orderEmailNorm = order.customer_email ? order.customer_email.toLowerCase().trim() : "";

    const phoneMatches = Boolean(submitterPhoneDigits && orderPhoneDigits && submitterPhoneDigits === orderPhoneDigits);
    const emailMatches = Boolean(submitterEmailNorm && orderEmailNorm && submitterEmailNorm === orderEmailNorm);

    if (!phoneMatches && !emailMatches) {
      const err = new Error("Order ownership verification failed. The provided contact details do not match the customer record on file for this order.");
      err.code = "ORDER_OWNERSHIP_MISMATCH";
      err.statusCode = 403;
      throw err;
    }

    const dupRes = await query(`SELECT id FROM customer_reviews WHERE order_id = $1;`, [ordId]);
    if (dupRes.rows.length > 0) {
      const err = new Error("A review has already been submitted for this order.");
      err.code = "DUPLICATE_REVIEW";
      err.statusCode = 409;
      throw err;
    }
    verifiedOrderId = order.id;
  }

  // 2. Validate Booking linkage & Ownership Verification (if provided)
  let verifiedBookingId = null;
  if (bkgId) {
    if (!isValidUuid(bkgId)) {
      const err = new Error("Invalid booking ID format. Must be a valid UUID.");
      err.code = "INVALID_BOOKING_ID";
      err.statusCode = 400;
      throw err;
    }
    const bkgRes = await query(
      `SELECT id, booking_status, customer_phone, customer_email FROM bookings WHERE id = $1;`,
      [bkgId]
    );
    if (bkgRes.rows.length === 0) {
      const err = new Error("Referenced booking does not exist.");
      err.code = "BOOKING_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }
    const bkg = bkgRes.rows[0];
    if (bkg.booking_status !== "COMPLETED") {
      const err = new Error("Reviews can only be submitted for completed salon appointments.");
      err.code = "BOOKING_NOT_ELIGIBLE_FOR_REVIEW";
      err.statusCode = 400;
      throw err;
    }

    // Security Guard: Submitter must provide contact info matching the booking record
    const submitterPhoneDigits = normalizePhoneDigits(phone);
    const bkgPhoneDigits = normalizePhoneDigits(bkg.customer_phone);
    const submitterEmailNorm = email ? email.toLowerCase().trim() : "";
    const bkgEmailNorm = bkg.customer_email ? bkg.customer_email.toLowerCase().trim() : "";

    const phoneMatches = Boolean(submitterPhoneDigits && bkgPhoneDigits && submitterPhoneDigits === bkgPhoneDigits);
    const emailMatches = Boolean(submitterEmailNorm && bkgEmailNorm && submitterEmailNorm === bkgEmailNorm);

    if (!phoneMatches && !emailMatches) {
      const err = new Error("Appointment ownership verification failed. The provided contact details do not match the client record on file for this appointment.");
      err.code = "BOOKING_OWNERSHIP_MISMATCH";
      err.statusCode = 403;
      throw err;
    }

    const dupRes = await query(`SELECT id FROM customer_reviews WHERE booking_id = $1;`, [bkgId]);
    if (dupRes.rows.length > 0) {
      const err = new Error("A review has already been submitted for this appointment.");
      err.code = "DUPLICATE_REVIEW";
      err.statusCode = 409;
      throw err;
    }
    verifiedBookingId = bkg.id;
  }

  // 3. Spam / duplicate submission control for unlinked storefront submissions
  if (!verifiedOrderId && !verifiedBookingId && phone) {
    const recentRes = await query(
      `SELECT id FROM customer_reviews
       WHERE customer_phone = $1 AND customer_name = $2 AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour';`,
      [phone, name]
    );
    if (recentRes.rows.length > 0) {
      const err = new Error("A feedback submission from this contact was already received recently.");
      err.code = "DUPLICATE_REVIEW";
      err.statusCode = 409;
      throw err;
    }
  }

  const insertRes = await query(
    `INSERT INTO customer_reviews (
       customer_name, customer_phone, customer_email,
       rating, title, review_text, service_or_product_tag,
       order_id, booking_id, source, is_approved
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE)
     RETURNING id, customer_name, rating, title, review_text, service_or_product_tag, source, is_approved, order_id, booking_id, created_at;`,
    [name, phone, email, numRating, revTitle, text, tag, verifiedOrderId, verifiedBookingId, source]
  );

  return insertRes.rows[0];
}

/**
 * Retrieves public approved reviews.
 * Strictly filters out any unapproved or rejected reviews.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
async function listPublicReviews(options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 50);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);

  const countRes = await query(`SELECT COUNT(*)::int AS total FROM customer_reviews WHERE is_approved = TRUE;`);
  const total = countRes.rows[0] ? countRes.rows[0].total : 0;

  const res = await query(
    `SELECT
       id,
       customer_name,
       rating,
       title,
       review_text,
       service_or_product_tag,
       FALSE AS is_verified_purchase,
       created_at
     FROM customer_reviews
     WHERE is_approved = TRUE
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2;`,
    [limit, offset]
  );

  return {
    reviews: res.rows,
    total,
    limit,
    offset,
  };
}

/**
 * Lists reviews for administrative moderation.
 * Supports filtering by status: 'all', 'pending', 'approved', 'rejected'.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
async function adminListReviews(options = {}) {
  const { status = "all", limit = 50, offset = 0 } = options;
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const whereConditions = [];
  const params = [];
  let paramIdx = 1;

  if (status === "pending") {
    whereConditions.push("is_approved = FALSE AND moderated_at IS NULL");
  } else if (status === "approved") {
    whereConditions.push("is_approved = TRUE");
  } else if (status === "rejected") {
    whereConditions.push("is_approved = FALSE AND moderated_at IS NOT NULL");
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  const countRes = await query(`SELECT COUNT(*)::int AS total FROM customer_reviews ${whereClause};`, params);
  const total = countRes.rows[0] ? countRes.rows[0].total : 0;

  const res = await query(
    `SELECT
       r.id,
       r.customer_name,
       r.customer_phone,
       r.customer_email,
       r.rating,
       r.title,
       r.review_text,
       r.service_or_product_tag,
       r.source,
       r.is_approved,
       r.moderated_at,
       r.moderation_notes,
       r.created_at,
       r.order_id,
       r.booking_id,
       u.email AS moderator_email,
       ap.display_name AS moderator_name
     FROM customer_reviews r
     LEFT JOIN users u ON u.id = r.moderated_by
     LEFT JOIN admin_profiles ap ON ap.user_id = r.moderated_by
     ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++};`,
    [...params, safeLimit, safeOffset]
  );

  return {
    reviews: res.rows,
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}

/**
 * Moderates a customer review (approves or declines).
 *
 * @param {string} reviewId
 * @param {object} moderationData
 * @param {object} adminUser
 * @param {string} ipAddress
 * @returns {Promise<object>}
 */
async function adminModerateReview(reviewId, moderationData, adminUser, ipAddress) {
  const { isApproved, notes } = moderationData;

  const existingRes = await query(`SELECT * FROM customer_reviews WHERE id = $1;`, [reviewId]);
  if (existingRes.rows.length === 0) {
    const err = new Error(`Review with ID '${reviewId}' not found.`);
    err.code = "REVIEW_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const existing = existingRes.rows[0];
  const moderatorId = isValidUuid(adminUser.id) ? adminUser.id : null;
  const updateRes = await query(
    `UPDATE customer_reviews
     SET is_approved = $1,
         moderated_by = $2,
         moderated_at = CURRENT_TIMESTAMP,
         moderation_notes = $3,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4
     RETURNING *;`,
    [Boolean(isApproved), moderatorId, notes || null, reviewId]
  );

  const updated = updateRes.rows[0];

  // Write immutable audit log
  const actorRole = (adminUser.roles && adminUser.roles[0]) || "operator";
  const actorId = isValidUuid(adminUser.id) ? adminUser.id : null;
  await query(
    `INSERT INTO audit_logs (
       actor_id, actor_role, action, target_entity, target_id,
       diff, ip_address
     ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
    [
      actorId,
      actorRole,
      isApproved ? "review:approve" : "review:reject",
      "customer_reviews",
      reviewId,
      JSON.stringify({
        customer_name: existing.customer_name,
        previous_approved: existing.is_approved,
        new_approved: Boolean(isApproved),
        notes: notes || null,
      }),
      formatInetIp(ipAddress),
    ]
  );

  return updated;
}

module.exports = {
  submitCustomerReview,
  listPublicReviews,
  adminListReviews,
  adminModerateReview,
};
