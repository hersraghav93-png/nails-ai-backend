/**
 * ==========================================================================
 * AUTHENTICATION ROUTER (`src/routes/authRoute.js`)
 * Nails by Divya Platform
 *
 * Provides:
 * - GET /api/auth/me: Returns current authenticated user, profile, roles, and permissions.
 * ==========================================================================
 */

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { emailRequestRateLimiter, emailVerifyRateLimiter } = require("../middleware/rateLimiter");
const { requestMagicLink, verifyMagicLink } = require("../services/emailAuthService");

const router = express.Router();

/**
 * POST /api/auth/email/request-link
 * Requests a passwordless, single-use, 15-minute customer login link sent via Resend.
 * Anti-enumeration: always returns a uniform generic success message for valid email formats.
 */
router.post("/email/request-link", emailRequestRateLimiter, async (req, res) => {
  try {
    const email = req.body && req.body.email;
    const origin = req.headers.origin || null;
    const result = await requestMagicLink({
      email,
      origin,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"] || null,
    });
    return res.json(result);
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Unable to send sign-in email.",
      code: err.code || "EMAIL_REQUEST_FAILED",
    });
  }
});

/**
 * POST /api/auth/email/verify-link
 * Atomically verifies a single-use hashed email login token, associates historical
 * guest orders/bookings with the verified email, and returns a Firebase custom token.
 */
router.post("/email/verify-link", emailVerifyRateLimiter, async (req, res) => {
  try {
    const token = req.body && req.body.token;
    const result = await verifyMagicLink({
      token,
      ipAddress: req.ip,
    });
    return res.json(result);
  } catch (err) {
    const status = err.statusCode || 401;
    return res.status(status).json({
      error: err.message || "Invalid or expired sign-in link.",
      code: err.code || "TOKEN_INVALID",
    });
  }
});

/**
 * GET /api/auth/me
 * Retrieves current user identity, profile, and authorization claims.
 */
router.get("/me", requireAuth, (req, res) => {
  const user = req.user;

  res.json({
    status: "success",
    user: {
      id: user.id,
      firebase_uid: user.firebase_uid,
      phone: user.phone,
      phone_verified_at: user.phone_verified_at,
      email: user.email,
      email_verified_at: user.email_verified_at,
      is_active: user.is_active,
      roles: user.roles,
      permissions: user.permissions,
      profile: user.profile,
      adminProfile: user.adminProfile,
      created_at: user.created_at,
      updated_at: user.updated_at,
    },
  });
});

/**
 * POST /api/auth/verify-phone
 * Accepts authenticated Firebase ID Token (via Bearer header or body { idToken }),
 * verifies the token with Firebase Admin SDK, links/binds the Firebase UID to the
 * existing PostgreSQL user record (preserving phone and roles like artist_divya),
 * and returns the authenticated user identity and authorization claims.
 */
router.post("/verify-phone", async (req, res, next) => {
  // If idToken is passed in body and no Authorization header is present, synthesize it
  if (!req.headers.authorization && req.body && req.body.idToken && typeof req.body.idToken === "string") {
    req.headers.authorization = `Bearer ${req.body.idToken.trim()}`;
  }

  return requireAuth(req, res, () => {
    const user = req.user;
    return res.json({
      status: "success",
      user: {
        id: user.id,
        firebase_uid: user.firebase_uid,
        phone: user.phone,
        phone_verified_at: user.phone_verified_at,
        email: user.email,
        email_verified_at: user.email_verified_at,
        is_active: user.is_active,
        roles: user.roles,
        permissions: user.permissions,
        profile: user.profile,
        adminProfile: user.adminProfile,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
    });
  });
});

module.exports = router;
