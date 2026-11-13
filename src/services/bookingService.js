/**
 * ==========================================================================
 * BOOKING SERVICE (`src/services/bookingService.js`)
 * Nails by Divya Platform — Phase 2B Appointment Engine
 *
 * Implements at-home appointment request and lifecycle management:
 * - Request-and-manual-confirmation workflow for Delhi NCR appointments
 * - Server-side service and add-on validation with NULL price preservation
 * - Date and time window validation (rejecting past or invalid dates)
 * - Guest and authenticated customer ownership verification
 * - Alternative slot proposal, confirmation, decline, and cancellation
 * - Detailed status history and audit logging with RBAC enforcement
 * ==========================================================================
 */

"use strict";

const crypto = require("crypto");
const { getPool, query } = require("../db/pool");
const { validateAndFormatPhone } = require("./orderService");
const { queueNotification } = require("./notifications/notificationService");

// Allowed booking status values from database check constraints
const ALLOWED_BOOKING_STATUSES = [
  "REQUESTED",
  "DIVYA_REVIEWING",
  "ALTERNATIVE_PROPOSED",
  "CONFIRMED",
  "IN_PROGRESS",
  "COMPLETED",
  "DECLINED",
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_ARTIST",
];

// Valid time slots commonly requested for at-home appointments
const DEFAULT_TIME_SLOTS = [
  "10:00 AM - 12:00 PM",
  "12:30 PM - 02:30 PM",
  "03:00 PM - 05:00 PM",
  "05:30 PM - 07:30 PM",
];

/**
 * Normalizes client IP address to valid PostgreSQL INET format.
 * @param {string|null} ip
 * @returns {string|null}
 */
function formatInetIp(ip) {
  if (!ip || typeof ip !== "string") return null;
  const clean = ip.trim();
  if (clean === "::1") return "127.0.0.1";
  if (clean.startsWith("::ffff:")) return clean.replace(/^::ffff:/, "");
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return clean;
  if (clean.includes(":")) return clean;
  return null;
}

/**
 * Validates requested appointment date. Must be YYYY-MM-DD and not in the past.
 *
 * @param {string} dateStr Date string in YYYY-MM-DD format
 * @returns {string} Normalized date string
 */
function validateRequestedDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") {
    const err = new Error("Requested appointment date is required.");
    err.code = "INVALID_DATE";
    err.statusCode = 400;
    throw err;
  }

  const clean = dateStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    const err = new Error("Appointment date must be in YYYY-MM-DD format.");
    err.code = "INVALID_DATE_FORMAT";
    err.statusCode = 400;
    throw err;
  }

  const [year, month, day] = clean.split("-").map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));

  // Check valid Gregorian calendar date
  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day
  ) {
    const err = new Error("Appointment date is an invalid calendar date.");
    err.code = "INVALID_DATE";
    err.statusCode = 400;
    throw err;
  }

  // Check date is not in the past (comparison against today's start in UTC)
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (parsedDate < todayUtc) {
    const err = new Error("Appointment date cannot be in the past. Please select an upcoming date.");
    err.code = "PAST_DATE_NOT_ALLOWED";
    err.statusCode = 400;
    throw err;
  }

  // Booking window limit: max 60 days in advance
  const maxAdvanceDate = new Date(todayUtc);
  maxAdvanceDate.setUTCDate(maxAdvanceDate.getUTCDate() + 60);

  if (parsedDate > maxAdvanceDate) {
    const err = new Error("Appointments cannot be requested more than 60 days in advance.");
    err.code = "DATE_TOO_FAR_IN_ADVANCE";
    err.statusCode = 400;
    throw err;
  }

  return clean;
}

/**
 * Validates requested time slot string.
 * @param {string} slotStr
 * @returns {string}
 */
function validateTimeSlot(slotStr) {
  if (!slotStr || typeof slotStr !== "string") {
    const err = new Error("Preferred time slot is required.");
    err.code = "INVALID_TIME_SLOT";
    err.statusCode = 400;
    throw err;
  }

  const clean = slotStr.trim();
  if (clean.length < 3 || clean.length > 50) {
    const err = new Error("Preferred time slot must be between 3 and 50 characters.");
    err.code = "INVALID_TIME_SLOT";
    err.statusCode = 400;
    throw err;
  }

  return clean;
}

/**
 * Validates service delivery address in Delhi NCR.
 */
function validateServiceAddress(addr) {
  if (!addr || typeof addr !== "object") {
    const err = new Error("Service appointment address is required.");
    err.code = "ADDRESS_REQUIRED";
    err.statusCode = 400;
    throw err;
  }

  const addressLine1 = (addr.address_line1 || addr.addressLine1 || addr.line1 || "").trim();
  if (!addressLine1 || addressLine1.length < 5 || addressLine1.length > 255) {
    const err = new Error("Address line 1 must be between 5 and 255 characters.");
    err.code = "INVALID_ADDRESS_LINE1";
    err.statusCode = 400;
    throw err;
  }

  const city = (addr.city || "Delhi NCR").trim();
  const state = (addr.state || "Delhi").trim();
  const locality = (addr.locality || addr.neighborhood || "").trim();

  const postalCode = (addr.postal_code || addr.postalCode || addr.pincode || addr.pin || "").toString().trim();
  if (!/^[1-9][0-9]{5}$/.test(postalCode)) {
    const err = new Error("Postal code must be a valid 6-digit Indian PIN code.");
    err.code = "INVALID_PINCODE";
    err.statusCode = 400;
    throw err;
  }

  return {
    address_line1: addressLine1,
    address_line2: (addr.address_line2 || addr.addressLine2 || "").trim() || null,
    landmark: (addr.landmark || "").trim() || null,
    locality: locality || null,
    city,
    state,
    postal_code: postalCode,
  };
}

/**
 * Retrieves all active salon services with approved pricing and addons.
 * Preserves NULL prices without converting them to zero.
 *
 * @returns {Promise<Array<object>>}
 */
async function listAvailableServices() {
  const servicesRes = await query(
    `SELECT 
       s.id,
       s.name,
       s.base_price,
       s.promotional_price,
       s.estimated_duration_minutes,
       s.description,
       s.is_active
     FROM services s
     WHERE s.is_active = TRUE
     ORDER BY s.id ASC;`
  );

  const addonsRes = await query(
    `SELECT 
       id,
       service_id,
       name,
       price,
       is_active
     FROM service_addons
     WHERE is_active = TRUE
     ORDER BY name ASC;`
  );

  // Group addons by service_id
  const addonsByService = {};
  for (const addon of addonsRes.rows) {
    if (!addonsByService[addon.service_id]) {
      addonsByService[addon.service_id] = [];
    }
    addonsByService[addon.service_id].push({
      id: addon.id,
      name: addon.name,
      price: addon.price !== null ? parseFloat(addon.price) : null,
      isCustomQuote: addon.price === null,
      priceDisplay: addon.price !== null ? `₹${parseFloat(addon.price)}` : "Custom Quote",
    });
  }

  return servicesRes.rows.map((svc) => {
    const basePrice = svc.base_price !== null ? parseFloat(svc.base_price) : null;
    const promoPrice = svc.promotional_price !== null ? parseFloat(svc.promotional_price) : null;
    const effectivePrice = promoPrice !== null ? promoPrice : basePrice;

    return {
      id: svc.id,
      name: svc.name,
      basePrice,
      promotionalPrice: promoPrice,
      effectivePrice,
      isCustomQuote: effectivePrice === null,
      pricingDisplay: effectivePrice !== null ? `From ₹${effectivePrice}` : "Custom Quote",
      estimatedDurationMinutes: svc.estimated_duration_minutes,
      description: svc.description,
      addons: addonsByService[svc.id] || [],
    };
  });
}

/**
 * Retrieves detailed info for an individual service with its active add-ons.
 *
 * @param {string} serviceId
 * @returns {Promise<object>}
 */
async function getServiceDetails(serviceId) {
  const serviceRes = await query(
    `SELECT * FROM services WHERE id = $1 AND is_active = TRUE;`,
    [serviceId]
  );

  if (serviceRes.rows.length === 0) {
    const err = new Error(`Service '${serviceId}' not found or is currently inactive.`);
    err.code = "SERVICE_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const svc = serviceRes.rows[0];

  const addonsRes = await query(
    `SELECT id, name, price FROM service_addons WHERE service_id = $1 AND is_active = TRUE;`,
    [serviceId]
  );

  const basePrice = svc.base_price !== null ? parseFloat(svc.base_price) : null;
  const promoPrice = svc.promotional_price !== null ? parseFloat(svc.promotional_price) : null;
  const effectivePrice = promoPrice !== null ? promoPrice : basePrice;

  return {
    id: svc.id,
    name: svc.name,
    basePrice,
    promotionalPrice: promoPrice,
    effectivePrice,
    isCustomQuote: effectivePrice === null,
    pricingDisplay: effectivePrice !== null ? `From ₹${effectivePrice}` : "Custom Quote",
    estimatedDurationMinutes: svc.estimated_duration_minutes,
    description: svc.description,
    addons: addonsRes.rows.map((a) => ({
      id: a.id,
      name: a.name,
      price: a.price !== null ? parseFloat(a.price) : null,
      isCustomQuote: a.price === null,
      priceDisplay: a.price !== null ? `₹${parseFloat(a.price)}` : "Custom Quote",
    })),
  };
}

/**
 * Creates an at-home appointment request within an atomic PostgreSQL transaction.
 *
 * @param {object} params
 * @param {string|null} [params.userId]
 * @param {string|null} [params.sessionToken]
 * @param {object} params.customer { name, phone, email }
 * @param {string} params.serviceId
 * @param {Array<string>} [params.addonIds]
 * @param {object} params.serviceAddress
 * @param {string} params.requestedDate (YYYY-MM-DD)
 * @param {string} params.requestedTimeSlot
 * @param {string|null} [params.customerNotes]
 * @param {string|null} [params.referenceImageUrl]
 * @param {string|null} [params.idempotencyKey]
 * @param {string|null} [params.ipAddress]
 * @returns {Promise<object>}
 */
async function createAppointmentRequest({
  userId = null,
  sessionToken = null,
  customer,
  serviceId,
  addonIds = [],
  serviceAddress,
  requestedDate,
  requestedTimeSlot,
  customerNotes = null,
  referenceImageUrl = null,
  idempotencyKey = null,
  ipAddress = null,
}) {
  if (!customer || typeof customer !== "object") {
    const err = new Error("Customer contact details are required.");
    err.code = "CUSTOMER_REQUIRED";
    err.statusCode = 400;
    throw err;
  }

  const customerName = (customer.name || customer.fullName || "").trim();
  if (customerName.length < 2 || customerName.length > 100) {
    const err = new Error("Customer name must be between 2 and 100 characters.");
    err.code = "INVALID_NAME";
    err.statusCode = 400;
    throw err;
  }

  const customerPhone = validateAndFormatPhone(customer.phone);
  const customerEmail = customer.email && typeof customer.email === "string" && customer.email.trim()
    ? customer.email.trim()
    : null;

  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    const err = new Error("Invalid customer email address format.");
    err.code = "INVALID_EMAIL";
    err.statusCode = 400;
    throw err;
  }

  const validatedDate = validateRequestedDate(requestedDate);
  const validatedTimeSlot = validateTimeSlot(requestedTimeSlot);
  const validatedAddress = validateServiceAddress(serviceAddress);

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    // 1. Idempotency Check: Return existing booking if key already processed
    if (idempotencyKey && typeof idempotencyKey === "string" && idempotencyKey.trim()) {
      const cleanKey = idempotencyKey.trim();
      const existingRes = await client.query(
        `SELECT id, booking_number, user_id, booking_status, created_at 
         FROM bookings 
         WHERE guest_session_token = $1 
            OR artist_private_notes = $2;`,
        [`idem:${cleanKey}`, `[IDEMPOTENCY_KEY: ${cleanKey}]`]
      );

      if (existingRes.rows.length > 0) {
        await client.query("COMMIT;");
        const existing = existingRes.rows[0];
        const fullExisting = await getAppointmentById(existing.id, {
          userId,
          sessionToken,
          isAdmin: false,
          skipAuthCheck: true,
        });
        return {
          ...fullExisting,
          isDuplicate: true,
          message: "Appointment request previously submitted (idempotent response).",
        };
      }
    }

    // 2. Validate Service Existence and Pricing
    const serviceRes = await client.query(
      `SELECT * FROM services WHERE id = $1 AND is_active = TRUE;`,
      [serviceId]
    );

    if (serviceRes.rows.length === 0) {
      const err = new Error(`Service '${serviceId}' does not exist or is inactive.`);
      err.code = "INVALID_SERVICE_ID";
      err.statusCode = 400;
      throw err;
    }

    const service = serviceRes.rows[0];

    // 3. Validate Add-ons if supplied
    let selectedAddons = [];
    let addonsTotal = 0;
    let hasCustomQuoteAddon = false;

    if (Array.isArray(addonIds) && addonIds.length > 0) {
      const addonsRes = await client.query(
        `SELECT id, name, price, service_id 
         FROM service_addons 
         WHERE id = ANY($1::uuid[]) AND service_id = $2 AND is_active = TRUE;`,
        [addonIds, serviceId]
      );

      if (addonsRes.rows.length !== addonIds.length) {
        const err = new Error("One or more selected add-ons are invalid or do not belong to this service.");
        err.code = "INVALID_ADDON_ID";
        err.statusCode = 400;
        throw err;
      }

      selectedAddons = addonsRes.rows.map((a) => {
        const price = a.price !== null ? parseFloat(a.price) : null;
        if (price === null) hasCustomQuoteAddon = true;
        else addonsTotal += price;
        return {
          id: a.id,
          name: a.name,
          price,
          isCustomQuote: price === null,
        };
      });
    }

    // 4. Server-Side Price Calculation (Preserving NULL prices for manual quotation)
    const servicePrice = service.promotional_price !== null
      ? parseFloat(service.promotional_price)
      : (service.base_price !== null ? parseFloat(service.base_price) : null);

    const isCustomQuote = servicePrice === null || hasCustomQuoteAddon;

    // Database check constraint requires estimated_total >= 0 (cannot be NULL)
    // We store the numeric total (or 0.00 for unquoted) while recording unquoted status in metadata
    const numericEstimatedTotal = isCustomQuote && servicePrice === null
      ? 0.00
      : parseFloat(((servicePrice || 0) + addonsTotal).toFixed(2));

    // 5. Generate Sequential Booking Number
    const seqRes = await client.query(`SELECT nextval('booking_number_seq') AS seq;`);
    const bookingSeq = seqRes.rows[0].seq;
    const bookingNumber = `NBD-BKG-${bookingSeq}`;

    // 6. Generate Guest Claim Secret for unauthenticated requests
    let claimSecret = null;
    let guestClaimHash = null;
    if (!userId) {
      claimSecret = crypto.randomBytes(16).toString("hex");
      guestClaimHash = crypto.createHash("sha256").update(claimSecret).digest("hex");
    }

    const guestSessionToken = idempotencyKey
      ? `idem:${idempotencyKey.trim()}`
      : (sessionToken || (claimSecret ? `guest_${claimSecret.slice(0, 16)}` : null));

    const artistPrivateNotes = idempotencyKey
      ? `[IDEMPOTENCY_KEY: ${idempotencyKey.trim()}]`
      : null;

    // Package comprehensive service & quotation details into service_address JSONB
    const fullServiceAddressPayload = {
      ...validatedAddress,
      service_name: service.name,
      service_id: service.id,
      selected_addons: selectedAddons,
      pricing: {
        service_price: servicePrice,
        addons_total: addonsTotal,
        numeric_total: numericEstimatedTotal,
        is_custom_quote: isCustomQuote,
        pricing_display: isCustomQuote
          ? (servicePrice !== null ? `From ₹${servicePrice} + Custom Add-ons` : "Custom Quote (Pending Divya's Review)")
          : `₹${numericEstimatedTotal}`,
      },
      reference_image_url: referenceImageUrl || null,
      guest_claim_hash: guestClaimHash,
    };

    // 7. Insert Booking Record
    // Note: Initial status is strictly 'REQUESTED' (manual review required)
    const insertRes = await client.query(
      `INSERT INTO bookings (
         booking_number,
         user_id,
         guest_session_token,
         customer_name,
         customer_phone,
         customer_email,
         service_id,
         service_address,
         postal_code,
         service_area_id,
         requested_date,
         requested_time_slot,
         booking_status,
         payment_status,
         estimated_total,
         customer_notes,
         artist_private_notes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *;`,
      [
        bookingNumber,
        userId || null,
        guestSessionToken,
        customerName,
        customerPhone,
        customerEmail,
        serviceId,
        JSON.stringify(fullServiceAddressPayload),
        validatedAddress.postal_code,
        "DELHI-NCR",
        validatedDate,
        validatedTimeSlot,
        "REQUESTED",
        "PENDING",
        numericEstimatedTotal,
        customerNotes ? customerNotes.substring(0, 500) : null,
        artistPrivateNotes,
      ]
    );

    const booking = insertRes.rows[0];

    // 8. Record Initial Status in booking_status_history
    await client.query(
      `INSERT INTO booking_status_history (
         booking_id,
         from_status,
         to_status,
         actor_type,
         actor_id,
         notes
       ) VALUES ($1, $2, $3, $4, $5, $6);`,
      [
        booking.id,
        null,
        "REQUESTED",
        "customer",
        userId || null,
        "Appointment requested by customer. Pending manual artist review and schedule confirmation.",
      ]
    );

    // 9. Record Audit Log Entry
    await client.query(
      `INSERT INTO audit_logs (
         actor_id,
         actor_role,
         action,
         target_entity,
         target_id,
         diff,
         ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        userId || null,
        userId ? "customer" : "guest",
        "BOOKING_REQUESTED",
        "bookings",
        booking.id,
        JSON.stringify({
          booking_number: booking.booking_number,
          service_id: serviceId,
          requested_date: validatedDate,
          requested_time_slot: validatedTimeSlot,
          is_custom_quote: isCustomQuote,
          estimated_total: numericEstimatedTotal,
        }),
        formatInetIp(ipAddress),
      ]
    );

    await client.query("COMMIT;");

    // Queue appointment request acknowledgement notification
    try {
      const addr = fullServiceAddressPayload || {};
      const addrStr = `${addr.address_line1 || ""}, ${addr.city || ""}, PIN ${addr.postal_code || ""}`;

      await queueNotification({
        channel: "whatsapp",
        recipientPhone: booking.customer_phone,
        templateKey: "APPOINTMENT_REQUESTED",
        variables: {
          customerName: booking.customer_name,
          bookingNumber: booking.booking_number,
          bookingId: booking.id,
          serviceName: service.name,
          requestedDate: formatDateOnly(booking.requested_date),
          requestedTimeSlot: booking.requested_time_slot,
          serviceAddress: addrStr,
        },
        idempotencyKey: `booking_${booking.id}_requested`,
      });
    } catch (notifErr) {
      console.warn(`⚠️ [Booking Notification Error] Booking ${booking.id}: ${notifErr.message}`);
    }

    return {
      booking: formatBookingOutput(booking, fullServiceAddressPayload),
      claimSecret, // Returned to guest for future lookup / ownership verification
    };
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Formats a Date object or date string to YYYY-MM-DD using local calendar components
 * so that timezone offsets do not shift dates by one day.
 *
 * @param {Date|string|null} d
 * @returns {string|null}
 */
function formatDateOnly(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  if (d instanceof Date) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(d);
}

/**
 * Formats database booking row into a clean, client-facing representation.
 * Preserves NULL prices as null rather than converting them to zero.
 */
function formatBookingOutput(booking, parsedAddress = null) {
  const addressObj = parsedAddress || (
    typeof booking.service_address === "string"
      ? JSON.parse(booking.service_address)
      : booking.service_address
  ) || {};

  const pricing = addressObj.pricing || {};
  const isCustomQuote = Boolean(pricing.is_custom_quote);

  return {
    id: booking.id,
    bookingNumber: booking.booking_number,
    userId: booking.user_id,
    customerName: booking.customer_name,
    customerPhone: booking.customer_phone,
    customerEmail: booking.customer_email,
    serviceId: booking.service_id,
    serviceName: addressObj.service_name || booking.service_id,
    selectedAddons: addressObj.selected_addons || [],
    serviceAddress: {
      addressLine1: addressObj.address_line1,
      addressLine2: addressObj.address_line2,
      landmark: addressObj.landmark,
      locality: addressObj.locality,
      city: addressObj.city,
      state: addressObj.state,
      postalCode: booking.postal_code,
    },
    requestedDate: formatDateOnly(booking.requested_date),
    requestedTimeSlot: booking.requested_time_slot,
    alternativeProposedDate: formatDateOnly(booking.alternative_proposed_date),
    alternativeProposedTimeSlot: booking.alternative_proposed_time_slot,
    rescheduleReason: booking.reschedule_reason,
    confirmedStartTime: booking.confirmed_start_time,
    confirmedEndTime: booking.confirmed_end_time,
    bookingStatus: booking.booking_status,
    paymentStatus: booking.payment_status,
    // Preserve NULL prices as null for unquoted services/add-ons
    estimatedTotal: isCustomQuote ? null : parseFloat(booking.estimated_total),
    pricingDisplay: pricing.pricing_display || (isCustomQuote ? "Custom Quote" : `₹${booking.estimated_total}`),
    isCustomQuote,
    customerNotes: booking.customer_notes,
    referenceImageUrl: addressObj.reference_image_url || null,
    createdAt: booking.created_at,
    updatedAt: booking.updated_at,
  };
}

/**
 * Retrieves appointment details by authorized owner or admin.
 *
 * @param {string} bookingId Booking UUID
 * @param {object} authContext { userId, sessionToken, claimSecret, isAdmin, skipAuthCheck }
 * @returns {Promise<object>}
 */
async function getAppointmentById(bookingId, authContext = {}) {
  const { userId, sessionToken, claimSecret, isAdmin, skipAuthCheck } = authContext;

  const bookingRes = await query(
    `SELECT * FROM bookings WHERE id = $1;`,
    [bookingId]
  );

  if (bookingRes.rows.length === 0) {
    const err = new Error("Appointment request not found.");
    err.code = "BOOKING_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const booking = bookingRes.rows[0];
  const addressObj = typeof booking.service_address === "string"
    ? JSON.parse(booking.service_address)
    : booking.service_address || {};

  // Ownership verification: prevent cross-customer access
  if (!skipAuthCheck && !isAdmin) {
    let isAuthorized = false;

    // 1. Authenticated customer ownership
    if (userId && booking.user_id === userId) {
      isAuthorized = true;
    }

    // 2. Guest claim secret verification
    if (!isAuthorized && claimSecret && addressObj.guest_claim_hash) {
      const hashedSecret = crypto.createHash("sha256").update(claimSecret.trim()).digest("hex");
      if (hashedSecret === addressObj.guest_claim_hash) {
        isAuthorized = true;
      }
    }

    // 3. Guest session token verification
    if (!isAuthorized && sessionToken) {
      if (
        booking.guest_session_token === sessionToken ||
        booking.guest_session_token === `idem:${sessionToken}`
      ) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      const err = new Error("Access denied: You do not have permission to view this appointment.");
      err.code = "FORBIDDEN_BOOKING_ACCESS";
      err.statusCode = 403;
      throw err;
    }
  }

  // Retrieve complete status history
  const historyRes = await query(
    `SELECT id, from_status, to_status, actor_type, notes, created_at 
     FROM booking_status_history 
     WHERE booking_id = $1 
     ORDER BY created_at ASC;`,
    [bookingId]
  );

  // Retrieve related communication history
  const notificationsRes = await query(
    `SELECT id, channel, template_name, status, retry_count, scheduled_for, created_at,
            template_variables->>'__manualWaLink' AS manual_wa_link
     FROM notification_jobs
     WHERE template_variables->>'bookingId' = $1 OR template_variables->>'bookingNumber' = $2
     ORDER BY created_at DESC
     LIMIT 10;`,
    [bookingId, booking.booking_number]
  );

  return {
    booking: formatBookingOutput(booking, addressObj),
    statusHistory: historyRes.rows.map((h) => ({
      id: h.id,
      fromStatus: h.from_status,
      toStatus: h.to_status,
      actorType: h.actor_type,
      notes: h.notes,
      createdAt: h.created_at,
    })),
    notifications: notificationsRes.rows.map((n) => ({
      id: n.id,
      channel: n.channel,
      templateName: n.template_name,
      status: n.status,
      retryCount: n.retry_count,
      scheduledFor: n.scheduled_for,
      createdAt: n.created_at,
      manualWaLink: n.manual_wa_link,
    })),
  };
}

/**
 * Retrieves appointment request history for an authenticated customer.
 *
 * @param {string} userId Authenticated user UUID
 * @param {object} [pagination] { limit, offset }
 * @returns {Promise<{ bookings: Array<object>, total: number }>}
 */
async function getCustomerAppointments(userId, { limit = 20, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM bookings WHERE user_id = $1;`,
    [userId]
  );
  const total = countRes.rows[0].total;

  const bookingsRes = await query(
    `SELECT * FROM bookings 
     WHERE user_id = $1 
     ORDER BY created_at DESC 
     LIMIT $2 OFFSET $3;`,
    [userId, safeLimit, safeOffset]
  );

  return {
    bookings: bookingsRes.rows.map((row) => formatBookingOutput(row)),
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}

/**
 * Cancels an eligible appointment request by customer.
 * Allowed when status is REQUESTED, DIVYA_REVIEWING, or ALTERNATIVE_PROPOSED.
 *
 * @param {string} bookingId
 * @param {object} authContext { userId, sessionToken, claimSecret, isAdmin, reason }
 * @returns {Promise<object>} Updated appointment details
 */
async function cancelAppointmentRequest(bookingId, authContext = {}) {
  const { userId, sessionToken, claimSecret, isAdmin, reason } = authContext;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    const bookingRes = await client.query(
      `SELECT * FROM bookings WHERE id = $1 FOR UPDATE;`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      const err = new Error("Appointment not found.");
      err.code = "BOOKING_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const booking = bookingRes.rows[0];
    const addressObj = typeof booking.service_address === "string"
      ? JSON.parse(booking.service_address)
      : booking.service_address || {};

    // Ownership verification
    if (!isAdmin) {
      let isAuthorized = false;
      if (userId && booking.user_id === userId) isAuthorized = true;
      if (!isAuthorized && claimSecret && addressObj.guest_claim_hash) {
        const hashedSecret = crypto.createHash("sha256").update(claimSecret.trim()).digest("hex");
        if (hashedSecret === addressObj.guest_claim_hash) isAuthorized = true;
      }
      if (!isAuthorized && sessionToken) {
        if (
          booking.guest_session_token === sessionToken ||
          booking.guest_session_token === `idem:${sessionToken}`
        ) {
          isAuthorized = true;
        }
      }

      if (!isAuthorized) {
        const err = new Error("Access denied: You do not have permission to cancel this appointment.");
        err.code = "FORBIDDEN_BOOKING_ACCESS";
        err.statusCode = 403;
        throw err;
      }
    }

    // Cancellation eligibility check
    const cancellableStatuses = ["REQUESTED", "DIVYA_REVIEWING", "ALTERNATIVE_PROPOSED"];
    if (!cancellableStatuses.includes(booking.booking_status)) {
      const err = new Error(
        `Appointment ${booking.booking_number} cannot be cancelled online because it is currently '${booking.booking_status}'. Confirmed or ongoing at-home appointments require direct WhatsApp consultation with Divya.`
      );
      err.code = "BOOKING_CANNOT_BE_CANCELLED";
      err.statusCode = 400;
      throw err;
    }

    const targetStatus = isAdmin ? "CANCELLED_BY_ARTIST" : "CANCELLED_BY_CUSTOMER";
    const cancelNote = reason || (isAdmin ? "Appointment cancelled by studio operator." : "Appointment request cancelled by customer.");

    await client.query(
      `UPDATE bookings 
       SET booking_status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2;`,
      [targetStatus, bookingId]
    );

    await client.query(
      `INSERT INTO booking_status_history (
         booking_id,
         from_status,
         to_status,
         actor_type,
         actor_id,
         notes
       ) VALUES ($1, $2, $3, $4, $5, $6);`,
      [
        bookingId,
        booking.booking_status,
        targetStatus,
        isAdmin ? "divya" : "customer",
        userId || null,
        cancelNote,
      ]
    );

    await client.query("COMMIT;");

    // Queue cancellation notification
    try {
      await queueNotification({
        channel: "whatsapp",
        recipientPhone: booking.customer_phone,
        templateKey: "APPOINTMENT_CANCELLED",
        variables: {
          customerName: booking.customer_name,
          bookingNumber: booking.booking_number,
          bookingId: booking.id,
          cancellationReason: cancelNote,
        },
        idempotencyKey: `booking_${booking.id}_cancelled_${Date.now()}`,
      });
    } catch (notifErr) {
      console.warn(`[bookingService] Failed to queue cancellation notification for booking ${booking.id}:`, notifErr.message);
    }

    return getAppointmentById(bookingId, { isAdmin: true, skipAuthCheck: true });
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Administrative appointment listing with filtering and pagination.
 *
 * @param {object} filters { status, date, serviceId, search, limit, offset }
 * @returns {Promise<{ bookings: Array<object>, total: number }>}
 */
async function adminListAppointments(filters = {}) {
  const { status, date, serviceId, search, limit = 20, offset = 0 } = filters;

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const whereClauses = [];
  const params = [];
  let paramIdx = 1;

  if (status) {
    whereClauses.push(`b.booking_status = $${paramIdx++}`);
    params.push(status);
  }

  if (date) {
    whereClauses.push(`b.requested_date = $${paramIdx++}`);
    params.push(date);
  }

  if (serviceId) {
    whereClauses.push(`b.service_id = $${paramIdx++}`);
    params.push(serviceId);
  }

  if (search && typeof search === "string" && search.trim()) {
    const term = `%${search.trim()}%`;
    whereClauses.push(
      `(b.booking_number ILIKE $${paramIdx} OR b.customer_name ILIKE $${paramIdx} OR b.customer_phone ILIKE $${paramIdx})`
    );
    params.push(term);
    paramIdx++;
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM bookings b ${whereSql};`,
    params
  );
  const total = countRes.rows[0].total;

  params.push(safeLimit, safeOffset);
  const bookingsRes = await query(
    `SELECT b.*, s.name AS service_title 
     FROM bookings b
     JOIN services s ON b.service_id = s.id
     ${whereSql}
     ORDER BY b.requested_date ASC, b.created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++};`,
    params
  );

  return {
    bookings: bookingsRes.rows.map((row) => formatBookingOutput(row)),
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}

/**
 * Confirms an appointment request and locks in the confirmed schedule.
 *
 * @param {string} bookingId
 * @param {object} confirmData { confirmedStartTime, confirmedEndTime, notes }
 * @param {object} adminUser
 * @param {string|null} [ipAddress]
 * @returns {Promise<object>}
 */
async function confirmAppointmentRequest(bookingId, confirmData, adminUser, ipAddress = null) {
  const { confirmedStartTime, confirmedEndTime, notes } = confirmData;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    const bookingRes = await client.query(
      `SELECT * FROM bookings WHERE id = $1 FOR UPDATE;`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      const err = new Error("Appointment not found.");
      err.code = "BOOKING_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const booking = bookingRes.rows[0];

    // Allowed from REQUESTED, DIVYA_REVIEWING, or ALTERNATIVE_PROPOSED
    if (["COMPLETED", "DECLINED", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_ARTIST"].includes(booking.booking_status)) {
      const err = new Error(
        `Cannot confirm appointment in '${booking.booking_status}' status.`
      );
      err.code = "INVALID_STATUS_TRANSITION";
      err.statusCode = 400;
      throw err;
    }

    const startTime = confirmedStartTime ? new Date(confirmedStartTime) : new Date();
    const endTime = confirmedEndTime ? new Date(confirmedEndTime) : new Date(startTime.getTime() + 2 * 3600 * 1000);

    await client.query(
      `UPDATE bookings 
       SET booking_status = 'CONFIRMED',
           confirmed_start_time = $1,
           confirmed_end_time = $2,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3;`,
      [startTime, endTime, bookingId]
    );

    await client.query(
      `INSERT INTO booking_status_history (
         booking_id,
         from_status,
         to_status,
         actor_type,
         actor_id,
         notes
       ) VALUES ($1, $2, $3, $4, $5, $6);`,
      [
        bookingId,
        booking.booking_status,
        "CONFIRMED",
        "divya",
        adminUser.id,
        notes || "Appointment confirmed by Divya for scheduled slot.",
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (
         actor_id,
         actor_role,
         action,
         target_entity,
         target_id,
         diff,
         ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        adminUser.id,
        (adminUser.roles && adminUser.roles[0]) || "artist_divya",
        "BOOKING_CONFIRMED",
        "bookings",
        bookingId,
        JSON.stringify({
          previous_status: booking.booking_status,
          confirmed_start_time: startTime.toISOString(),
          confirmed_end_time: endTime.toISOString(),
          notes: notes || null,
        }),
        formatInetIp(ipAddress),
      ]
    );

    await client.query("COMMIT;");

    // Queue confirmation notification
    try {
      const svcRes = await query(`SELECT name FROM services WHERE id = $1;`, [booking.service_id]);
      const serviceName = svcRes.rows.length > 0 ? svcRes.rows[0].name : "At-Home Nail Service";
      const addrObj = typeof booking.service_address === "string" ? JSON.parse(booking.service_address) : (booking.service_address || {});
      const addrStr = `${addrObj.address_line1 || ""}, ${addrObj.city || ""}, PIN ${addrObj.postal_code || ""}`;

      await queueNotification({
        channel: "whatsapp",
        recipientPhone: booking.customer_phone,
        templateKey: "APPOINTMENT_CONFIRMED",
        variables: {
          customerName: booking.customer_name,
          bookingNumber: booking.booking_number,
          bookingId: booking.id,
          serviceName,
          confirmedDate: startTime.toLocaleDateString("en-IN"),
          confirmedSlot: `${startTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ${endTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
          serviceAddress: addrStr,
        },
        idempotencyKey: `booking_${booking.id}_confirmed`,
      });
    } catch (notifErr) {
      console.warn(`[bookingService] Failed to queue confirmation notification for booking ${booking.id}:`, notifErr.message);
    }

    return getAppointmentById(bookingId, { isAdmin: true, skipAuthCheck: true });
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Proposes an alternative date and time window when the requested slot is unavailable.
 *
 * @param {string} bookingId
 * @param {object} proposalData { alternativeDate, alternativeTimeSlot, rescheduleReason, notes }
 * @param {object} adminUser
 * @param {string|null} [ipAddress]
 * @returns {Promise<object>}
 */
async function proposeAlternativeSlot(bookingId, proposalData, adminUser, ipAddress = null) {
  const { alternativeDate, alternativeTimeSlot, rescheduleReason, notes } = proposalData;

  const validatedAltDate = validateRequestedDate(alternativeDate);
  const validatedAltSlot = validateTimeSlot(alternativeTimeSlot);

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    const bookingRes = await client.query(
      `SELECT * FROM bookings WHERE id = $1 FOR UPDATE;`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      const err = new Error("Appointment not found.");
      err.code = "BOOKING_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const booking = bookingRes.rows[0];

    if (["COMPLETED", "DECLINED", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_ARTIST"].includes(booking.booking_status)) {
      const err = new Error(
        `Cannot propose alternative slot for appointment in '${booking.booking_status}' status.`
      );
      err.code = "INVALID_STATUS_TRANSITION";
      err.statusCode = 400;
      throw err;
    }

    // Update appointment with proposed alternative slot
    // Database trigger trg_invalidate_prior_booking_tokens will auto-expire prior action tokens
    await client.query(
      `UPDATE bookings 
       SET booking_status = 'ALTERNATIVE_PROPOSED',
           alternative_proposed_date = $1,
           alternative_proposed_time_slot = $2,
           reschedule_reason = $3,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $4;`,
      [
        validatedAltDate,
        validatedAltSlot,
        rescheduleReason || "Divya is fully booked during the originally requested window.",
        bookingId,
      ]
    );

    // Generate secure customer action token for accepting or declining the alternative
    const rawActionToken = crypto.randomBytes(24).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawActionToken).digest("hex");
    const tokenExpiry = new Date(Date.now() + 24 * 3600 * 1000); // 24 hours validity

    await client.query(
      `INSERT INTO booking_action_tokens (
         booking_id,
         action_type,
         token_hash,
         expires_at
       ) VALUES ($1, $2, $3, $4);`,
      [bookingId, "ACCEPT_ALTERNATIVE", tokenHash, tokenExpiry]
    );

    await client.query(
      `INSERT INTO booking_status_history (
         booking_id,
         from_status,
         to_status,
         actor_type,
         actor_id,
         notes
       ) VALUES ($1, $2, $3, $4, $5, $6);`,
      [
        bookingId,
        booking.booking_status,
        "ALTERNATIVE_PROPOSED",
        "divya",
        adminUser.id,
        notes || `Alternative slot proposed: ${validatedAltDate} (${validatedAltSlot}). Reason: ${rescheduleReason || "Schedule conflict"}`,
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (
         actor_id,
         actor_role,
         action,
         target_entity,
         target_id,
         diff,
         ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        adminUser.id,
        (adminUser.roles && adminUser.roles[0]) || "artist_divya",
        "BOOKING_ALTERNATIVE_PROPOSED",
        "bookings",
        bookingId,
        JSON.stringify({
          previous_status: booking.booking_status,
          alternative_proposed_date: validatedAltDate,
          alternative_proposed_time_slot: validatedAltSlot,
          reschedule_reason: rescheduleReason || null,
        }),
        formatInetIp(ipAddress),
      ]
    );

    await client.query("COMMIT;");

    // Queue alternative proposal notification
    try {
      await queueNotification({
        channel: "whatsapp",
        recipientPhone: booking.customer_phone,
        templateKey: "APPOINTMENT_ALTERNATIVE_PROPOSED",
        variables: {
          customerName: booking.customer_name,
          bookingNumber: booking.booking_number,
          bookingId: booking.id,
          proposedDate: validatedAltDate,
          proposedSlot: validatedAltSlot,
          rescheduleReason: rescheduleReason || "Studio schedule conflict",
        },
        idempotencyKey: `booking_${booking.id}_alt_proposed_${validatedAltDate}_${validatedAltSlot}`,
      });
    } catch (notifErr) {
      console.warn(`[bookingService] Failed to queue alternative proposal notification for booking ${booking.id}:`, notifErr.message);
    }

    const updated = await getAppointmentById(bookingId, { isAdmin: true, skipAuthCheck: true });
    return {
      ...updated,
      actionToken: rawActionToken, // Action token for customer notification / link
    };
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Declines an appointment request with an explicit reason.
 *
 * @param {string} bookingId
 * @param {object} declineData { reason, notes }
 * @param {object} adminUser
 * @param {string|null} [ipAddress]
 * @returns {Promise<object>}
 */
async function declineAppointmentRequest(bookingId, declineData, adminUser, ipAddress = null) {
  const { reason, notes } = declineData;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    const bookingRes = await client.query(
      `SELECT * FROM bookings WHERE id = $1 FOR UPDATE;`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      const err = new Error("Appointment not found.");
      err.code = "BOOKING_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const booking = bookingRes.rows[0];

    await client.query(
      `UPDATE bookings 
       SET booking_status = 'DECLINED', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1;`,
      [bookingId]
    );

    await client.query(
      `INSERT INTO booking_status_history (
         booking_id,
         from_status,
         to_status,
         actor_type,
         actor_id,
         notes
       ) VALUES ($1, $2, $3, $4, $5, $6);`,
      [
        bookingId,
        booking.booking_status,
        "DECLINED",
        "divya",
        adminUser.id,
        notes || reason || "Appointment declined by studio operator.",
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (
         actor_id,
         actor_role,
         action,
         target_entity,
         target_id,
         diff,
         ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        adminUser.id,
        (adminUser.roles && adminUser.roles[0]) || "artist_divya",
        "BOOKING_DECLINED",
        "bookings",
        bookingId,
        JSON.stringify({
          previous_status: booking.booking_status,
          reason: reason || null,
          notes: notes || null,
        }),
        formatInetIp(ipAddress),
      ]
    );

    await client.query("COMMIT;");

    // Queue decline notification
    try {
      await queueNotification({
        channel: "whatsapp",
        recipientPhone: booking.customer_phone,
        templateKey: "APPOINTMENT_DECLINED",
        variables: {
          customerName: booking.customer_name,
          bookingNumber: booking.booking_number,
          bookingId: booking.id,
          declineReason: reason || notes || "Outside service coverage perimeter",
        },
        idempotencyKey: `booking_${booking.id}_declined`,
      });
    } catch (notifErr) {
      console.warn(`[bookingService] Failed to queue decline notification for booking ${booking.id}:`, notifErr.message);
    }

    return getAppointmentById(bookingId, { isAdmin: true, skipAuthCheck: true });
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Updates an appointment's operational status (e.g. IN_PROGRESS, COMPLETED).
 *
 * @param {string} bookingId
 * @param {object} updateData { status, notes }
 * @param {object} adminUser
 * @param {string|null} [ipAddress]
 * @returns {Promise<object>}
 */
async function updateAppointmentStatus(bookingId, updateData, adminUser, ipAddress = null) {
  const { status, notes } = updateData;

  if (!status || !ALLOWED_BOOKING_STATUSES.includes(status)) {
    const err = new Error(
      `Invalid booking status '${status}'. Allowed statuses: ${ALLOWED_BOOKING_STATUSES.join(", ")}.`
    );
    err.code = "INVALID_BOOKING_STATUS";
    err.statusCode = 400;
    throw err;
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    const bookingRes = await client.query(
      `SELECT * FROM bookings WHERE id = $1 FOR UPDATE;`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      const err = new Error("Appointment not found.");
      err.code = "BOOKING_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const booking = bookingRes.rows[0];

    await client.query(
      `UPDATE bookings 
       SET booking_status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2;`,
      [status, bookingId]
    );

    await client.query(
      `INSERT INTO booking_status_history (
         booking_id,
         from_status,
         to_status,
         actor_type,
         actor_id,
         notes
       ) VALUES ($1, $2, $3, $4, $5, $6);`,
      [
        bookingId,
        booking.booking_status,
        status,
        "operator",
        adminUser.id,
        notes || `Booking status updated to ${status} by operator.`,
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (
         actor_id,
         actor_role,
         action,
         target_entity,
         target_id,
         diff,
         ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        adminUser.id,
        (adminUser.roles && adminUser.roles[0]) || "operator",
        "BOOKING_STATUS_UPDATED",
        "bookings",
        bookingId,
        JSON.stringify({
          previous_status: booking.booking_status,
          updated_status: status,
          notes: notes || null,
        }),
        formatInetIp(ipAddress),
      ]
    );

    await client.query("COMMIT;");

    return getAppointmentById(bookingId, { isAdmin: true, skipAuthCheck: true });
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ALLOWED_BOOKING_STATUSES,
  DEFAULT_TIME_SLOTS,
  validateRequestedDate,
  validateTimeSlot,
  validateServiceAddress,
  listAvailableServices,
  getServiceDetails,
  createAppointmentRequest,
  getAppointmentById,
  getCustomerAppointments,
  cancelAppointmentRequest,
  adminListAppointments,
  confirmAppointmentRequest,
  proposeAlternativeSlot,
  declineAppointmentRequest,
  updateAppointmentStatus,
};
