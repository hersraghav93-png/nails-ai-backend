/**
 * ==========================================================================
 * AUTHENTICATION & AUTHORIZATION MIDDLEWARE (`src/middleware/auth.js`)
 * Nails by Divya Platform
 *
 * Provides:
 * - requireAuth: Verifies Firebase ID Token, resolves PostgreSQL user & profile,
 *                verifies active account status.
 * - optionalAuth: Resolves user if Bearer token present; allows guests if omitted.
 * - requireRole: Enforces role-based access control (RBAC).
 * - requirePermission: Enforces granular permission-based authorization.
 * ==========================================================================
 */

const { verifyIdToken } = require("../services/firebaseService");
const { findOrCreateUserByFirebaseToken } = require("../services/userService");

/**
 * Extracts Bearer token from Authorization header.
 * @param {import("express").Request} req
 * @returns {string|null}
 */
function extractBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== "string") {
    return null;
  }
  const parts = authHeader.trim().split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }
  return null;
}

/**
 * Middleware: requireAuth
 * Requires a valid Firebase ID token in Authorization header.
 * Attaches verified and populated user object to req.user.
 */
async function requireAuth(req, res, next) {
  const token = extractBearerToken(req);

  if (!token) {
    return res.status(401).json({
      error: "Authentication required. Bearer token missing in Authorization header.",
      code: "AUTH_REQUIRED",
    });
  }

  try {
    const decodedToken = await verifyIdToken(token);
    const user = await findOrCreateUserByFirebaseToken(decodedToken);

    if (user.is_active === false) {
      return res.status(403).json({
        error: "Account has been deactivated or suspended. Please contact customer support.",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    req.user = user;
    req.firebaseUser = decodedToken;
    next();
  } catch (err) {
    const statusCode = err.statusCode || (err.code === "AUTH_SERVICE_UNCONFIGURED" ? 503 : 401);
    return res.status(statusCode).json({
      error: err.message || "Invalid authentication token.",
      code: err.code || "INVALID_TOKEN",
    });
  }
}

/**
 * Middleware: optionalAuth
 * Attempts to verify Bearer token if provided.
 * If token is valid, attaches req.user.
 * If no token is provided, proceeds as guest (req.user = null).
 * If invalid token is provided, rejects with 401.
 */
async function optionalAuth(req, res, next) {
  const token = extractBearerToken(req);

  if (!token) {
    req.user = null;
    req.firebaseUser = null;
    return next();
  }

  try {
    const decodedToken = await verifyIdToken(token);
    const user = await findOrCreateUserByFirebaseToken(decodedToken);

    if (user.is_active === false) {
      return res.status(403).json({
        error: "Account has been deactivated or suspended. Please contact customer support.",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    req.user = user;
    req.firebaseUser = decodedToken;
    next();
  } catch (err) {
    const statusCode = err.statusCode || 401;
    return res.status(statusCode).json({
      error: err.message || "Invalid authentication token.",
      code: err.code || "INVALID_TOKEN",
    });
  }
}

/**
 * Middleware: requireRole
 * Requires authenticated user to have at least one of the specified roles.
 *
 * @param {string|string[]} roles Allowed role or array of allowed roles
 */
function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Authentication required before role verification.",
        code: "AUTH_REQUIRED",
      });
    }

    if (req.user.is_active === false) {
      return res.status(403).json({
        error: "Account has been deactivated or suspended.",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    const userRoles = Array.isArray(req.user.roles) ? req.user.roles : [];
    const hasRole = allowed.some((role) => userRoles.includes(role));

    if (!hasRole) {
      return res.status(403).json({
        error: "Access denied. Insufficient administrative privileges.",
        code: "FORBIDDEN_ROLE",
        requiredRoles: allowed,
      });
    }

    next();
  };
}

/**
 * Middleware: requirePermission
 * Requires authenticated user to have a specific permission,
 * with super_operator holding universal override.
 *
 * @param {string} permissionId Permission name (e.g. 'orders:read', 'catalog:write')
 */
function requirePermission(permissionId) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Authentication required before permission verification.",
        code: "AUTH_REQUIRED",
      });
    }

    if (req.user.is_active === false) {
      return res.status(403).json({
        error: "Account has been deactivated or suspended.",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    const userRoles = Array.isArray(req.user.roles) ? req.user.roles : [];

    // Universal override for super_operator
    if (userRoles.includes("super_operator")) {
      return next();
    }

    const userPermissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    if (!userPermissions.includes(permissionId)) {
      return res.status(403).json({
        error: `Access denied. Missing required permission: "${permissionId}".`,
        code: "FORBIDDEN_PERMISSION",
        requiredPermission: permissionId,
      });
    }

    next();
  };
}

module.exports = {
  extractBearerToken,
  requireAuth,
  optionalAuth,
  requireRole,
  requirePermission,
};
