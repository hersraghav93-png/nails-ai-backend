/**
 * ==============================================================================
 * NOTIFICATION SERVICE (`src/services/notifications/notificationService.js`)
 * Nails by Divya Platform — Phase 3A Customer Communications
 *
 * Provides transactional lifecycle management for customer communications:
 * - Deterministic idempotency checking (prevents duplicate customer notifications)
 * - Queueing, asynchronous dispatch, exponential backoff retries, and audit logging
 * - Real delivery tracking using `notification_delivery_logs`
 * - Manual WhatsApp click-to-chat fallback links for administrative operators
 * ==============================================================================
 */

"use strict";

const { query, withTransaction } = require("../../db/pool");
const { renderTemplate } = require("./notificationTemplates");
const { sendWhatsAppNotification } = require("./whatsappAdapter");

/**
 * Queues a customer notification job idempotently.
 * If an identical idempotency key already exists, returns the existing job record.
 *
 * @param {object} params
 * @param {string} [params.channel="whatsapp"] Delivery channel
 * @param {string} params.recipientPhone Customer phone in E.164
 * @param {string} params.templateKey Key in TEMPLATES (e.g. 'ORDER_CONFIRMED')
 * @param {object} [params.variables={}] Template parameters
 * @param {number} [params.priority=5] Priority between 1 (lowest) and 10 (highest)
 * @param {string} [params.idempotencyKey] Unique idempotency key
 * @param {Date} [params.scheduledFor] Optional scheduled delivery time
 * @param {boolean} [params.autoDispatch=true] Whether to attempt immediate dispatch
 * @returns {Promise<{ job: object, isNew: boolean, waLink: string }>}
 */
async function queueNotification({
  channel = "whatsapp",
  recipientPhone,
  templateKey,
  variables = {},
  priority = 5,
  idempotencyKey = null,
  scheduledFor = null,
  autoDispatch = true,
}) {
  if (!recipientPhone || typeof recipientPhone !== "string" || !recipientPhone.trim()) {
    throw new Error("Recipient phone number is required.");
  }
  if (!templateKey || typeof templateKey !== "string") {
    throw new Error("Template key is required.");
  }

  // Pre-render to validate template and generate manual fallback link
  const rendered = renderTemplate(templateKey, variables, recipientPhone);

  // Compute fallback idempotency key if omitted
  const cleanKey = idempotencyKey || `${channel}_${templateKey}_${recipientPhone.replace(/\D/g, "")}_${Date.now()}`;
  const scheduledTime = scheduledFor ? new Date(scheduledFor) : new Date();

  // Enforce priority range
  const cleanPriority = Math.max(1, Math.min(10, parseInt(priority, 10) || 5));

  // Store rendered text in template_variables for record-keeping & fast manual fallback
  const enrichedVariables = {
    ...variables,
    __renderedText: rendered.text,
    __manualWaLink: rendered.waLink,
    __templateKey: templateKey,
  };

  // 1. Idempotent Insert into notification_jobs
  const insertSql = `
    INSERT INTO notification_jobs (
      channel,
      recipient_phone,
      template_name,
      template_variables,
      priority,
      status,
      retry_count,
      max_retries,
      scheduled_for,
      idempotency_key,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, 'QUEUED', 0, 3, $6, $7, NOW())
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING *;
  `;

  const insertRes = await query(insertSql, [
    channel.toLowerCase(),
    recipientPhone.trim(),
    rendered.templateName,
    JSON.stringify(enrichedVariables),
    cleanPriority,
    scheduledTime.toISOString(),
    cleanKey,
  ]);

  let job;
  let isNew = true;

  if (insertRes.rows.length > 0) {
    job = insertRes.rows[0];
  } else {
    // Already existed — retrieve existing record
    const existingRes = await query(
      `SELECT * FROM notification_jobs WHERE idempotency_key = $1;`,
      [cleanKey]
    );
    job = existingRes.rows[0];
    isNew = false;
  }

  // 2. Immediate dispatch if requested and job is fresh
  if (isNew && autoDispatch) {
    try {
      job = await processNotificationJob(job.id);
    } catch (dispatchErr) {
      console.warn(`⚠️ [Notification Auto-Dispatch Error] Job ${job.id}: ${dispatchErr.message}`);
    }
  }

  return {
    job,
    isNew,
    waLink: rendered.waLink,
  };
}

/**
 * Processes a single queued notification job.
 * Executes the provider adapter, records delivery logs, updates job status.
 *
 * @param {string} jobId UUID of the notification job
 * @returns {Promise<object>} Updated job record
 */
async function processNotificationJob(jobId) {
  if (!jobId) throw new Error("jobId is required.");

  return withTransaction(async (client) => {
    // 1. Lock job for execution
    const lockRes = await client.query(
      `SELECT * FROM notification_jobs WHERE id = $1 FOR UPDATE;`,
      [jobId]
    );

    if (lockRes.rows.length === 0) {
      throw new Error(`Notification job "${jobId}" not found.`);
    }

    const job = lockRes.rows[0];

    // Already delivered or cancelled
    if (job.status === "SENT" || job.status === "CANCELLED") {
      return job;
    }

    // Set status to PROCESSING
    await client.query(
      `UPDATE notification_jobs SET status = 'PROCESSING' WHERE id = $1;`,
      [job.id]
    );

    const vars = job.template_variables || {};
    const text = vars.__renderedText || "";

    // 2. Dispatch via provider adapter
    let dispatchResult;
    try {
      if (job.channel === "whatsapp") {
        dispatchResult = await sendWhatsAppNotification({
          recipientPhone: job.recipient_phone,
          text,
          templateName: job.template_name,
          templateVariables: vars,
        });
      } else {
        dispatchResult = {
          success: false,
          deliveryStatus: "FAILED",
          providerMessageId: null,
          errorCode: "UNSUPPORTED_CHANNEL",
          errorMessage: `Channel "${job.channel}" is not yet supported.`,
          isSimulated: false,
        };
      }
    } catch (err) {
      dispatchResult = {
        success: false,
        deliveryStatus: "FAILED",
        providerMessageId: null,
        errorCode: "DISPATCH_EXCEPTION",
        errorMessage: err.message,
        isSimulated: false,
      };
    }

    // 3. Record in notification_delivery_logs
    await client.query(
      `INSERT INTO notification_delivery_logs (
         job_id,
         provider_message_id,
         delivery_status,
         error_code,
         error_message,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, NOW());`,
      [
        job.id,
        dispatchResult.providerMessageId || null,
        dispatchResult.deliveryStatus,
        dispatchResult.errorCode || null,
        dispatchResult.errorMessage || null,
      ]
    );

    // 4. Update notification_jobs status & retry count
    let nextStatus = dispatchResult.success ? "SENT" : "FAILED";
    const nextRetryCount = job.retry_count + (dispatchResult.success ? 0 : 1);

    // Exponential backoff if retryable and under max retries
    let nextScheduledFor = job.scheduled_for;
    if (!dispatchResult.success && nextRetryCount < job.max_retries) {
      nextStatus = "QUEUED"; // Keep queued for retry
      const backoffMinutes = Math.pow(2, nextRetryCount) * 5; // 10m, 20m, 40m
      nextScheduledFor = new Date(Date.now() + backoffMinutes * 60 * 1000);
    }

    const updateRes = await client.query(
      `UPDATE notification_jobs
       SET status = $1,
           retry_count = $2,
           scheduled_for = $3
       WHERE id = $4
       RETURNING *;`,
      [nextStatus, nextRetryCount, nextScheduledFor, job.id]
    );

    return updateRes.rows[0];
  });
}

/**
 * Lists notification jobs with delivery telemetry and operator fallback links.
 *
 * @param {object} [filters={}] { status, channel, search, limit, offset }
 * @returns {Promise<{ notifications: Array<object>, total: number }>}
 */
async function listNotifications(filters = {}) {
  const { status, channel, search, limit = 50, offset = 0 } = filters;

  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (status && status !== "ALL") {
    conditions.push(`nj.status = $${paramIdx++}`);
    params.push(status.toUpperCase());
  }

  if (channel && channel !== "ALL") {
    conditions.push(`nj.channel = $${paramIdx++}`);
    params.push(channel.toLowerCase());
  }

  if (search && search.trim()) {
    conditions.push(`(
      nj.recipient_phone ILIKE $${paramIdx} OR
      nj.template_variables->>'orderNumber' ILIKE $${paramIdx} OR
      nj.template_variables->>'bookingNumber' ILIKE $${paramIdx} OR
      nj.template_variables->>'customerName' ILIKE $${paramIdx}
    )`);
    params.push(`%${search.trim()}%`);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Count query
  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM notification_jobs nj ${whereClause};`,
    params
  );
  const total = countRes.rows[0] ? countRes.rows[0].total : 0;

  // Data query with latest delivery log
  params.push(Math.min(100, Math.max(1, parseInt(limit, 10) || 50)));
  const limitIdx = paramIdx++;
  params.push(Math.max(0, parseInt(offset, 10) || 0));
  const offsetIdx = paramIdx++;

  const listSql = `
    SELECT
      nj.id,
      nj.channel,
      nj.recipient_phone,
      nj.template_name,
      nj.template_variables,
      nj.priority,
      nj.status,
      nj.retry_count,
      nj.max_retries,
      nj.scheduled_for,
      nj.idempotency_key,
      nj.created_at,
      ndl.provider_message_id,
      ndl.delivery_status,
      ndl.error_code,
      ndl.error_message,
      ndl.updated_at AS last_delivery_attempt_at
    FROM notification_jobs nj
    LEFT JOIN LATERAL (
      SELECT *
      FROM notification_delivery_logs
      WHERE job_id = nj.id
      ORDER BY updated_at DESC
      LIMIT 1
    ) ndl ON true
    ${whereClause}
    ORDER BY nj.created_at DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx};
  `;

  const listRes = await query(listSql, params);

  const notifications = listRes.rows.map((row) => {
    const vars = row.template_variables || {};
    return {
      id: row.id,
      channel: row.channel.toUpperCase(),
      recipientPhone: row.recipient_phone,
      templateName: row.template_name,
      status: row.status,
      priority: row.priority,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      scheduledFor: row.scheduled_for,
      createdAt: row.created_at,
      referenceType: vars.bookingNumber ? "BOOKING" : (vars.orderNumber ? "ORDER" : "GENERAL"),
      referenceCode: vars.bookingNumber || vars.orderNumber || null,
      customerName: vars.customerName || null,
      renderedText: vars.__renderedText || null,
      manualWaLink: vars.__manualWaLink || null,
      delivery: {
        status: row.delivery_status || row.status,
        providerMessageId: row.provider_message_id,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        lastAttemptAt: row.last_delivery_attempt_at,
      },
    };
  });

  return { notifications, total };
}

/**
 * Retries a failed or queued notification job manually.
 *
 * @param {string} jobId UUID of job
 * @param {object} actor User initiating retry
 * @returns {Promise<object>}
 */
async function retryNotification(jobId, actor = null) {
  const job = await processNotificationJob(jobId);

  // Audit log
  if (actor && actor.id) {
    await query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, target_entity, target_id, diff, ip_address)
       VALUES ($1, $2, 'NOTIFICATION_RETRY_TRIGGERED', 'notification_jobs', $3, $4, '127.0.0.1');`,
      [
        actor.id,
        (actor.roles && actor.roles[0]) || "operator",
        jobId,
        JSON.stringify({ status: job.status, retryCount: job.retry_count }),
      ]
    );
  }

  return job;
}

module.exports = {
  queueNotification,
  processNotificationJob,
  listNotifications,
  retryNotification,
};
