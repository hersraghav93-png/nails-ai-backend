/**
 * ==========================================================================
 * PRIVACY-SAFE OPERATIONAL ANALYTICS SERVICE (`src/services/analyticsService.js`)
 * Nails by Divya Platform — Phase 5.2.1
 *
 * Provides lightweight, privacy-first operational analytics:
 * - Whitelists 6 critical business events:
 *     1. product_view
 *     2. add_to_cart
 *     3. checkout_start
 *     4. order_submission
 *     5. booking_submission
 *     6. whatsapp_click
 * - Strictly strips all customer PII (names, phone numbers, emails, addresses, payment tokens)
 * - Persists aggregated daily counts in PostgreSQL `business_settings` (`analytics:daily:YYYY-MM-DD`)
 * - Zero third-party tracking scripts, cookies, or fabricated data
 * ==========================================================================
 */

"use strict";

const { query } = require("../db");

const VALID_EVENTS = Object.freeze([
  "product_view",
  "add_to_cart",
  "checkout_start",
  "order_submission",
  "booking_submission",
  "whatsapp_click",
]);

const PII_DISALLOWED_KEYS = Object.freeze([
  "customer", "name", "customerName", "customer_name", "fullName",
  "phone", "customerPhone", "customer_phone", "mobile", "telephone",
  "email", "customerEmail", "customer_email",
  "address", "shippingAddress", "serviceAddress", "address_line1", "address_line2", "street",
  "token", "password", "idToken", "accessToken", "refreshToken", "secret",
  "upiId", "utr", "paymentToken", "notes", "customerNotes"
]);

// In-memory daily counter fallback cache (ensures uninterrupted recording)
const inMemoryDailyCounts = {};

/**
 * Sanitizes an event properties object by stripping any customer PII.
 *
 * @param {object} properties Raw event properties
 * @returns {object} Sanitized properties
 */
function sanitizePayload(properties) {
  if (!properties || typeof properties !== "object") return {};
  const clean = {};
  for (const [k, v] of Object.entries(properties)) {
    if (!PII_DISALLOWED_KEYS.includes(k) && typeof v !== "object") {
      clean[k] = v;
    }
  }
  return clean;
}

/**
 * Records an analytics event, safely incrementing daily aggregate counters.
 *
 * @param {object} rawPayload { event, timestamp, properties }
 * @returns {Promise<{ success: boolean, event: string, date: string }>}
 */
async function recordEvent(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") {
    const err = new Error("Invalid analytics payload format.");
    err.statusCode = 400;
    throw err;
  }

  const eventName = rawPayload.event;
  if (!VALID_EVENTS.includes(eventName)) {
    const err = new Error(`Unsupported analytics event '${eventName}'. Allowed events: ${VALID_EVENTS.join(", ")}`);
    err.statusCode = 400;
    throw err;
  }

  let dateStr;
  try {
    dateStr = rawPayload.timestamp
      ? new Date(rawPayload.timestamp).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  } catch {
    dateStr = new Date().toISOString().slice(0, 10);
  }

  const settingKey = `analytics:daily:${dateStr}`;

  // Update in-memory counts
  if (!inMemoryDailyCounts[settingKey]) {
    inMemoryDailyCounts[settingKey] = {
      date: dateStr,
      product_view: 0,
      add_to_cart: 0,
      checkout_start: 0,
      order_submission: 0,
      booking_submission: 0,
      whatsapp_click: 0,
    };
  }
  inMemoryDailyCounts[settingKey][eventName] = (inMemoryDailyCounts[settingKey][eventName] || 0) + 1;

  // Persist daily aggregate to database (business_settings)
  try {
    await query(
      `INSERT INTO business_settings (key, value, description)
       VALUES ($1, jsonb_build_object('date', $2::text, $3::text, 1), 'Daily privacy-safe analytics aggregation')
       ON CONFLICT (key) DO UPDATE
       SET value = jsonb_set(
         business_settings.value,
         ARRAY[$3::text],
         to_jsonb(COALESCE((business_settings.value->>$3)::int, 0) + 1),
         true
       ),
       updated_at = CURRENT_TIMESTAMP;`,
      [settingKey, dateStr, eventName]
    );
  } catch (dbErr) {
    // Non-fatal fallback: logging and memory retention
    console.warn(`⚠️  [Analytics Warning] Could not persist event count to database: ${dbErr.message}`);
  }

  return {
    success: true,
    event: eventName,
    date: dateStr,
  };
}

/**
 * Retrieves daily aggregated analytics counts.
 *
 * @param {number} [days=14] Number of days to retrieve
 * @returns {Promise<Array<object>>}
 */
async function getDailyAnalytics(days = 14) {
  try {
    const res = await query(
      `SELECT key, value, updated_at
       FROM business_settings
       WHERE key LIKE 'analytics:daily:%'
       ORDER BY key DESC
       LIMIT $1;`,
      [days]
    );

    if (res.rows && res.rows.length > 0) {
      return res.rows.map((r) => r.value);
    }
  } catch (dbErr) {
    console.warn(`⚠️  [Analytics Warning] Could not fetch analytics from database: ${dbErr.message}`);
  }

  // Fallback to in-memory records
  return Object.values(inMemoryDailyCounts).slice(-days);
}

module.exports = {
  VALID_EVENTS,
  PII_DISALLOWED_KEYS,
  sanitizePayload,
  recordEvent,
  getDailyAnalytics,
};
