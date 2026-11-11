/**
 * ==============================================================================
 * WHATSAPP WEBHOOK ROUTER (`src/routes/webhookRoute.js`)
 * Nails by Divya Platform — Phase 4A Staging Integration
 *
 * Implements Meta WhatsApp Cloud API webhooks:
 * - GET  /api/webhooks/whatsapp -> Subscription challenge verification
 * - POST /api/webhooks/whatsapp -> Inbound delivery receipts (SENT/DELIVERED/FAILED)
 *   with HMAC SHA-256 signature verification (X-Hub-Signature-256)
 * ==============================================================================
 */

"use strict";

const express = require("express");
const router = express.Router();
const CONFIG = require("../config");
const { query } = require("../db/pool");
const { verifyWebhookSignature } = require("../services/notifications/whatsappAdapter");

/**
 * GET /api/webhooks/whatsapp
 * Meta Webhook Verification endpoint.
 * Responds to Meta's subscription challenge during webhook setup.
 */
router.get("/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const configuredToken = (CONFIG.notifications && CONFIG.notifications.whatsapp && CONFIG.notifications.whatsapp.webhookVerifyToken) || "";

  if (mode === "subscribe" && token && configuredToken && token === configuredToken) {
    console.log("✅ [WhatsApp Webhook] Meta challenge verified successfully.");
    return res.status(200).send(challenge);
  }

  console.warn("⚠️ [WhatsApp Webhook] Challenge verification failed: invalid token or mode.", { mode, tokenProvided: Boolean(token) });
  return res.status(403).json({
    error: "Webhook verification failed. Token mismatch or invalid mode.",
    code: "VERIFICATION_FAILED",
  });
});

/**
 * POST /api/webhooks/whatsapp
 * Processes inbound message delivery receipts and status updates from Meta.
 */
router.post("/whatsapp", async (req, res) => {
  const signatureHeader = req.headers["x-hub-signature-256"];
  const appSecret = (CONFIG.notifications && CONFIG.notifications.whatsapp && CONFIG.notifications.whatsapp.appSecret) || "";

  // 1. Signature validation (if appSecret is configured or in staging/prod)
  if (appSecret) {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const isValid = verifyWebhookSignature(rawBody, signatureHeader, appSecret);
    if (!isValid) {
      console.warn("🚨 [WhatsApp Webhook] Invalid X-Hub-Signature-256 received!");
      return res.status(401).json({
        error: "Invalid webhook signature.",
        code: "INVALID_WEBHOOK_SIGNATURE",
      });
    }
  }

  // 2. Process payload
  const body = req.body;
  if (!body || body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) {
    // Non-WhatsApp event or heartbeat ping
    return res.status(200).json({ status: "ignored" });
  }

  try {
    const statusUpdates = [];

    for (const entry of body.entry) {
      if (!Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        if (change.field !== "messages" || !change.value) continue;

        const value = change.value;
        const statuses = value.statuses || [];

        for (const s of statuses) {
          const providerMsgId = s.id;
          const rawStatus = (s.status || "").toLowerCase();
          const errors = s.errors && s.errors[0] ? s.errors[0] : null;

          let normalizedStatus = "SENT";
          if (rawStatus === "delivered") normalizedStatus = "DELIVERED";
          else if (rawStatus === "read") normalizedStatus = "READ";
          else if (rawStatus === "failed") normalizedStatus = "FAILED";
          else if (rawStatus === "sent") normalizedStatus = "SENT";

          const errorCode = errors ? String(errors.code) : null;
          const errorMessage = errors ? (errors.title || errors.message || "Meta delivery failed") : null;

          // Update notification_delivery_logs
          const updateLogRes = await query(
            `UPDATE notification_delivery_logs
             SET delivery_status = $1,
                 error_code = COALESCE($2, error_code),
                 error_message = COALESCE($3, error_message),
                 updated_at = NOW()
             WHERE provider_message_id = $4
             RETURNING *;`,
            [normalizedStatus, errorCode, errorMessage, providerMsgId]
          );

          if (updateLogRes.rows.length > 0) {
            const logEntry = updateLogRes.rows[0];

            // If DELIVERED or FAILED, update parent notification_jobs status
            if (normalizedStatus === "DELIVERED" || normalizedStatus === "FAILED") {
              await query(
                `UPDATE notification_jobs
                 SET status = $1
                 WHERE id = $2;`,
                [normalizedStatus === "DELIVERED" ? "SENT" : "FAILED", logEntry.job_id]
              );
            }

            statusUpdates.push({
              providerMsgId,
              status: normalizedStatus,
              jobId: logEntry.job_id,
            });
          }
        }
      }
    }

    return res.status(200).json({
      status: "received",
      processedCount: statusUpdates.length,
      updates: statusUpdates,
    });
  } catch (err) {
    console.error("❌ [WhatsApp Webhook Error]:", err.message);
    // Always return 200 to Meta to avoid infinite delivery retry floods
    return res.status(200).json({ status: "error_logged", error: err.message });
  }
});

module.exports = router;
