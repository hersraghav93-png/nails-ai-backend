/**
 * ==========================================================================
 * BOOKING & SERVICES ROUTER (`src/routes/bookingRoute.js`)
 * Nails by Divya Platform — Phase 2B Appointment Engine
 *
 * REST API Endpoints for customer at-home appointments & service catalog:
 * - GET    /api/services                  -> List all active services with approved pricing
 * - GET    /api/services/:id              -> Service details with active add-ons
 * - POST   /api/bookings                  -> Submit appointment request (guest or auth)
 * - GET    /api/bookings                  -> Customer's own appointment requests (auth)
 * - GET    /api/bookings/:bookingId       -> Detailed appointment view (owner isolated)
 * - POST   /api/bookings/:bookingId/cancel-> Cancel eligible pending appointment request
 * ==========================================================================
 */

"use strict";

const express = require("express");
const { optionalAuth, requireAuth } = require("../middleware/auth");
const {
  listAvailableServices,
  getServiceDetails,
  createAppointmentRequest,
  getAppointmentById,
  getCustomerAppointments,
  cancelAppointmentRequest,
} = require("../services/bookingService");

const router = express.Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Simple in-memory rate limiter for public appointment submissions
const submissionAttempts = new Map();
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SUBMISSIONS_PER_WINDOW = 15;

function checkRateLimit(ip) {
  if (!ip) return true;
  const now = Date.now();
  const entry = submissionAttempts.get(ip) || [];
  const validTimestamps = entry.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (validTimestamps.length >= MAX_SUBMISSIONS_PER_WINDOW) {
    return false;
  }
  validTimestamps.push(now);
  submissionAttempts.set(ip, validTimestamps);
  return true;
}

/**
 * Helper to resolve session token from headers, query, or body.
 */
function resolveSessionToken(req) {
  const headerToken = req.headers["x-booking-session"] || req.headers["x-cart-session"];
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

// =============================================================================
// SERVICE CATALOG ENDPOINTS
// =============================================================================

/**
 * GET /api/services
 * Retrieves all approved salon services and active add-ons.
 * Preserves NULL prices for manual/custom quotes.
 */
router.get("/services", async (req, res) => {
  try {
    const services = await listAvailableServices();
    return res.json({
      status: "success",
      count: services.length,
      services,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Failed to retrieve service catalog.",
      code: "SERVICES_FETCH_FAILED",
    });
  }
});

/**
 * GET /api/services/:serviceId
 * Retrieves detailed info for an individual service with its available add-ons.
 */
router.get("/services/:serviceId", async (req, res) => {
  try {
    const service = await getServiceDetails(req.params.serviceId);
    return res.json({
      status: "success",
      service,
    });
  } catch (err) {
    const status = err.statusCode || 404;
    return res.status(status).json({
      error: err.message || "Service not found.",
      code: err.code || "SERVICE_FETCH_FAILED",
    });
  }
});

// =============================================================================
// APPOINTMENT REQUEST ENDPOINTS
// =============================================================================

/**
 * POST /api/bookings
 * Submits a new at-home appointment request (supports guest & authenticated customers).
 * Strictly enters REQUESTED status (never confirmed automatically).
 */
router.post("/bookings", optionalAuth, async (req, res) => {
  try {
    // Rate limit check
    if (!checkRateLimit(req.ip)) {
      return res.status(429).json({
        error: "Too many appointment requests from this IP. Please wait a few minutes before submitting again.",
        code: "RATE_LIMIT_EXCEEDED",
      });
    }

    const sessionToken = resolveSessionToken(req);
    const idempotencyKey = resolveIdempotencyKey(req);
    const userId = req.user ? req.user.id : null;

    // Build customer object (derive verified phone from auth if missing)
    const customer = {
      ...(req.body.customer || {}),
    };
    if (req.user && req.user.phone && !customer.phone) {
      customer.phone = req.user.phone;
    }
    if (req.user && req.user.profile && req.user.profile.full_name && !customer.name) {
      customer.name = req.user.profile.full_name;
    }

    const result = await createAppointmentRequest({
      userId,
      sessionToken,
      customer,
      serviceId: req.body.service_id,
      addonIds: req.body.addon_ids || [],
      serviceAddress: req.body.service_address,
      requestedDate: req.body.requested_date,
      requestedTimeSlot: req.body.requested_time_slot,
      customerNotes: req.body.customer_notes || req.body.additional_requirements,
      referenceImageUrl: req.body.reference_image_url,
      idempotencyKey,
      ipAddress: req.ip,
    });

    const statusCode = result.isDuplicate ? 200 : 201;
    return res.status(statusCode).json({
      status: "success",
      message: result.isDuplicate
        ? "Appointment request retrieved from previous submission."
        : "Appointment request submitted successfully. Pending manual review by Divya.",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to submit appointment request.",
      code: err.code || "BOOKING_REQUEST_FAILED",
    });
  }
});

/**
 * GET /api/bookings
 * Retrieves authenticated customer's own appointment requests.
 */
router.get("/bookings", requireAuth, async (req, res) => {
  try {
    const result = await getCustomerAppointments(req.user.id, {
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
      error: err.message || "Failed to retrieve appointment history.",
      code: err.code || "BOOKING_LIST_FAILED",
    });
  }
});

/**
 * GET /api/bookings/:bookingId
 * Retrieves detailed appointment view by authorized owner (User ID, guest claim secret, session token, or admin).
 */
router.get("/bookings/:bookingId", optionalAuth, async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.bookingId)) {
      return res.status(404).json({
        error: "Appointment not found. Invalid appointment identifier format.",
        code: "BOOKING_NOT_FOUND",
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

    const result = await getAppointmentById(req.params.bookingId, {
      userId,
      sessionToken,
      claimSecret,
      isAdmin,
    });

    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || (err.code === "BOOKING_NOT_FOUND" ? 404 : 403);
    return res.status(status).json({
      error: err.message || "Failed to retrieve appointment.",
      code: err.code || "BOOKING_FETCH_FAILED",
    });
  }
});

/**
 * POST /api/bookings/:bookingId/cancel
 * Cancels an eligible pending appointment request (before artist confirmation).
 */
router.post("/bookings/:bookingId/cancel", optionalAuth, async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.bookingId)) {
      return res.status(404).json({
        error: "Appointment not found. Invalid appointment identifier format.",
        code: "BOOKING_NOT_FOUND",
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

    const result = await cancelAppointmentRequest(req.params.bookingId, {
      userId,
      sessionToken,
      claimSecret,
      isAdmin,
      reason: req.body && req.body.reason,
    });

    return res.json({
      status: "success",
      message: "Appointment request has been successfully cancelled.",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to cancel appointment request.",
      code: err.code || "BOOKING_CANCEL_FAILED",
    });
  }
});

module.exports = router;
