/**
 * ==========================================================================
 * SECURE CORS CONFIGURATION (`src/middleware/corsConfig.js`)
 * Nails by Divya Platform
 *
 * Restricts cross-origin resource sharing to authorized origins in live
 * environments, while permitting local developer instances on localhost.
 * ==========================================================================
 */

const cors = require("cors");
const CONFIG = require("../config");

// Authorized production domains (actual business website is nailsbydivya.store)
const ALLOWED_PROD_ORIGINS = [
  "https://nailsbydivya.store",
  "https://www.nailsbydivya.store",
];

// Authorized staging / preview domains
const ALLOWED_STAGING_ORIGINS = [
  "https://staging.nailsbydivya.store",
  "https://preview.nailsbydivya.store",
  "https://staging-admin.nailsbydivya.store",
];

// Authorized local development origins
const ALLOWED_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:5000",
  "http://127.0.0.1:5000",
];

function isOriginAllowed(origin, env) {
  if (!origin) return true;

  const currentEnv = env || (CONFIG.isProduction() ? "production" : (CONFIG.isStaging() ? "staging" : "development"));
  const envOrigins = process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN;

  if (currentEnv === "production") {
    if (envOrigins) {
      const customAllowed = envOrigins.split(",").map((s) => s.trim()).filter(Boolean);
      const sanitizedProd = customAllowed.filter(
        (o) => !ALLOWED_STAGING_ORIGINS.includes(o) && !ALLOWED_DEV_ORIGINS.includes(o) && !o.includes("localhost") && !o.includes("127.0.0.1")
      );
      if (sanitizedProd.includes(origin)) return true;
    }
    return ALLOWED_PROD_ORIGINS.includes(origin);
  }

  if (currentEnv === "staging") {
    if (envOrigins) {
      const customAllowed = envOrigins.split(",").map((s) => s.trim()).filter(Boolean);
      // Strictly prevent production and localhost origins on staging API
      const sanitizedStaging = customAllowed.filter(
        (o) => !ALLOWED_PROD_ORIGINS.includes(o) && !ALLOWED_DEV_ORIGINS.includes(o) && !o.includes("localhost") && !o.includes("127.0.0.1")
      );
      if (sanitizedStaging.includes(origin)) return true;
    }
    return ALLOWED_STAGING_ORIGINS.includes(origin);
  }

  if (
    ALLOWED_DEV_ORIGINS.includes(origin) ||
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:") ||
    origin === "null"
  ) {
    return true;
  }

  return currentEnv === "development" || currentEnv === "test";
}

function getCorsOriginValidator(env) {
  return (origin, callback) => {
    if (isOriginAllowed(origin, env)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS policy violation: origin "${origin}" is not authorized.`), false);
  };
}

function getCorsMiddleware() {
  return cors({
    origin: (origin, callback) => {
      getCorsOriginValidator()(origin, callback);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-admin-key",
      "X-Cart-Session",
      "x-cart-session",
      "X-Claim-Secret",
      "x-claim-secret",
      "X-Idempotency-Key",
      "x-idempotency-key",
      "X-Hub-Signature-256",
      "x-hub-signature-256",
    ],
    exposedHeaders: ["X-Cart-Session", "x-cart-session", "X-Claim-Secret", "x-claim-secret"],
    maxAge: 86400, // 24 hours pre-flight caching
  });
}

module.exports = {
  getCorsMiddleware,
  getCorsOriginValidator,
  isOriginAllowed,
  ALLOWED_PROD_ORIGINS,
  ALLOWED_STAGING_ORIGINS,
  ALLOWED_DEV_ORIGINS,
};
