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

// Authorized production/staging domains
const ALLOWED_PROD_ORIGINS = [
  "https://nailsbydivya.com",
  "https://www.nailsbydivya.com",
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

function getCorsMiddleware() {
  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
      if (!origin) {
        return callback(null, true);
      }

      // Check configured custom origins from environment
      if (process.env.ALLOWED_ORIGINS) {
        const customAllowed = process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
        if (customAllowed.includes(origin)) {
          return callback(null, true);
        }
      }

      // In production/staging, enforce strict whitelist
      if (CONFIG.isLiveEnvironment()) {
        if (ALLOWED_PROD_ORIGINS.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`CORS policy violation: origin "${origin}" is not authorized.`));
      }

      // In development/test, allow localhost origins or any local file origin
      if (
        ALLOWED_DEV_ORIGINS.includes(origin) ||
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:") ||
        origin === "null" // for file:// protocol
      ) {
        return callback(null, true);
      }

      // Default allow in pure development
      if (CONFIG.isDevelopment()) {
        return callback(null, true);
      }

      return callback(new Error(`CORS policy: origin "${origin}" not allowed.`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
    maxAge: 86400, // 24 hours pre-flight caching
  });
}

module.exports = {
  getCorsMiddleware,
  ALLOWED_PROD_ORIGINS,
  ALLOWED_DEV_ORIGINS,
};
