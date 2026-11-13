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

const router = express.Router();

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
