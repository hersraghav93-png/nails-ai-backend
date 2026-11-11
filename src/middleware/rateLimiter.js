/**
 * ==========================================================================
 * RATE LIMITING MIDDLEWARE (`src/middleware/rateLimiter.js`)
 * Nails by Divya Platform
 *
 * Provides in-memory sliding-window rate limiting for administrative APIs,
 * public auth endpoints, and AI chat to protect against DoS and brute-force abuse.
 * Automatically bypassed in test runner executions.
 * ==========================================================================
 */

const CONFIG = require("../config");

/**
 * Creates an in-memory rate limiting middleware.
 *
 * @param {object} options
 * @param {number} [options.windowMs=60000] Time window in milliseconds (default: 1 min)
 * @param {number} [options.max=60] Max requests per IP in the window
 * @param {string} [options.message="Too many requests. Please try again later."]
 * @returns {import("express").RequestHandler}
 */
function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000;
  const max = options.max || 60;
  const message = options.message || "Too many requests. Please try again later.";
  const hits = new Map();

  // Periodic cleanup to prevent unbounded memory growth
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits.entries()) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, valid);
      }
    }
  }, windowMs * 2);

  // Unref timer so it does not block Node process termination
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return (req, res, next) => {
    // In test runner mode, bypass rate limiter
    if (CONFIG.isTest()) {
      return next();
    }

    const ip = req.ip || req.connection.remoteAddress || "127.0.0.1";
    const now = Date.now();

    let timestamps = hits.get(ip) || [];
    timestamps = timestamps.filter((t) => now - t < windowMs);

    if (timestamps.length >= max) {
      const oldest = timestamps[0];
      const resetTime = Math.ceil((oldest + windowMs - now) / 1000);
      res.setHeader("Retry-After", resetTime > 0 ? resetTime : 1);
      res.setHeader("RateLimit-Limit", max);
      res.setHeader("RateLimit-Remaining", 0);
      return res.status(429).json({
        error: message,
        code: "RATE_LIMIT_EXCEEDED",
        retryAfterSeconds: resetTime > 0 ? resetTime : 1,
      });
    }

    timestamps.push(now);
    hits.set(ip, timestamps);

    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", Math.max(0, max - timestamps.length));
    next();
  };
}

// Preset rate limiters
const adminRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120, // 120 requests/min for admin dashboard
  message: "Too many administrative requests. Please slow down.",
});

const authRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30, // 30 requests/min for auth checks
  message: "Too many authentication attempts. Please wait before retrying.",
});

const chatRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20, // 20 requests/min for AI customer support
  message: "Message rate limit reached. Please wait a moment before sending another message.",
});

module.exports = {
  createRateLimiter,
  adminRateLimiter,
  authRateLimiter,
  chatRateLimiter,
};
