/**
 * ==========================================================================
 * ADMINISTRATOR ROUTER (`src/routes/adminRoute.js`)
 * Nails by Divya Platform — Phase 2C Admin Operations Engine
 *
 * Provides protected administrative endpoints:
 * - GET   /api/admin/me            -> Admin identity, role assignments, and permissions
 * - GET   /api/admin/overview      -> Real-time operational metrics & revenue breakdown
 * - GET   /api/admin/orders        -> Orders list with search, status filters, and pagination
 * - GET   /api/admin/orders/:id    -> Order details, items, sizing, delivery, status history
 * - PATCH /api/admin/orders/:id/status -> Advance fulfillment/order status & audit log
 * - POST  /api/admin/orders/:id/cancel -> Cancel eligible orders & audit log
 * - GET   /api/admin/bookings      -> Delhi NCR appointment list with calendar filters
 * - GET   /api/admin/bookings/:id  -> Appointment details, address, client, status history
 * - PATCH /api/admin/bookings/:id/confirm -> Confirm appointment with locked time window
 * - PATCH /api/admin/bookings/:id/propose-slot -> Propose alternative date/slot with token
 * - PATCH /api/admin/bookings/:id/reject  -> Decline appointment with explicit reason
 * - PATCH /api/admin/bookings/:id/cancel  -> Studio cancellation with reason
 * - PATCH /api/admin/bookings/:id/status  -> Operational progress (IN_PROGRESS, COMPLETED)
 * - GET   /api/admin/customers     -> Customer directory with search, order & booking counts
 * - GET   /api/admin/customers/:id -> Customer profile, saved addresses, sizing, histories
 * - GET   /api/admin/products      -> Catalog products with SKU, prices, stock, primary images
 * - PATCH /api/admin/products/:id/availability -> Toggle product availability with audit log
 * - GET   /api/admin/services      -> Salon services with duration, NULL quotation, add-ons
 * - PATCH /api/admin/services/:id/availability -> Toggle service availability with audit log
 * - GET   /api/admin/staff         -> Administrative staff directory & assigned roles
 * - GET   /api/admin/roles         -> Roles & permissions matrix
 * - GET   /api/admin/settings      -> Business configuration settings
 * - GET   /api/admin/audit-logs    -> Immutable audit log trail
 * ==========================================================================
 */

"use strict";

const express = require("express");
const { requireAuth, requireRole, requirePermission } = require("../middleware/auth");
const { query } = require("../db/pool");
const {
  adminListOrders,
  adminUpdateOrderStatus,
  adminVerifyOrderPayment,
  getOrderById,
  cancelOrder,
} = require("../services/orderService");
const {
  adminListAppointments,
  confirmAppointmentRequest,
  proposeAlternativeSlot,
  declineAppointmentRequest,
  cancelAppointmentRequest,
  updateAppointmentStatus,
  getAppointmentById,
} = require("../services/bookingService");
const { getDailyAnalytics } = require("../services/analyticsService");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  getEnrichedOverview,
  listCustomers,
  getCustomerDetails,
  listAdminProducts,
  toggleProductAvailability,
  createAdminProduct,
  updateAdminProduct,
  archiveAdminProduct,
  addProductImage,
  deleteProductImage,
  listAdminPortfolio,
  createAdminPortfolio,
  updateAdminPortfolio,
  togglePortfolioAvailability,
  deleteAdminPortfolio,
  listAdminServices,
  toggleServiceAvailability,
  listStaffAccounts,
  getRolePermissionMatrix,
  listBusinessSettings,
  listAuditLogs,
} = require("../services/adminService");
const {
  adminListReviews,
  adminModerateReview,
} = require("../services/reviewService");
const {
  listNotifications,
  retryNotification,
} = require("../services/notifications/notificationService");

const router = express.Router();

// Base middleware for all admin endpoints: Must be authenticated and hold an admin role
router.use(requireAuth);
router.use(requireRole(["super_operator", "artist_divya", "staff_artist", "support_staff"]));

// =============================================================================
// 1. ADMIN IDENTITY & OVERVIEW
// =============================================================================

/**
 * GET /api/admin/me
 * Returns authenticated administrator's credentials, active roles, and granted permissions.
 */
router.get("/me", (req, res) => {
  res.json({
    status: "success",
    admin: {
      userId: req.user.id,
      firebaseUid: req.user.firebase_uid,
      phone: req.user.phone,
      email: req.user.email,
      displayName: req.user.adminProfile ? req.user.adminProfile.display_name : null,
      isMfaEnabled: req.user.adminProfile ? req.user.adminProfile.is_mfa_enabled : false,
      roles: req.user.roles,
      permissions: req.user.permissions,
      isActive: req.user.is_active,
    },
  });
});

/**
 * GET /api/admin/overview
 * Requires 'catalog:view' permission (super_operator, artist_divya, staff_artist).
 * Returns real-time platform metrics, revenue distinction (paid vs unpaid), and recent activity.
 */
router.get("/overview", requirePermission("catalog:view"), async (req, res) => {
  try {
    const overviewData = await getEnrichedOverview({
      range: req.query.range,
      dateFrom: req.query.date_from,
      dateTo: req.query.date_to,
    });

    res.json({
      status: "success",
      overview: overviewData,
      requestedBy: {
        userId: req.user.id,
        role: req.user.roles[0] || null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ [Admin Overview Error]:", err.message);
    res.status(500).json({
      error: "Failed to retrieve administrative overview metrics.",
      code: "METRICS_FETCH_ERROR",
    });
  }
});

// =============================================================================
// 2. ORDER MANAGEMENT
// =============================================================================

/**
 * GET /api/admin/orders
 * Requires 'View Orders' permission.
 * Lists orders with filtering, pagination, and customer info.
 */
router.get("/orders", requirePermission("View Orders"), async (req, res) => {
  try {
    const result = await adminListOrders({
      status: req.query.status,
      paymentStatus: req.query.payment_status,
      fulfilmentStatus: req.query.fulfilment_status,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to list orders.",
      code: err.code || "ADMIN_ORDER_LIST_FAILED",
    });
  }
});

/**
 * GET /api/admin/orders/:orderId
 * Requires 'View Orders' permission.
 * Retrieves full order details, line items, sizing, shipping, and complete status history.
 */
router.get("/orders/:orderId", requirePermission("View Orders"), async (req, res) => {
  try {
    const orderDetails = await getOrderById(req.params.orderId, {
      isAdmin: true,
      skipAuthCheck: true,
    });

    return res.json({
      status: "success",
      ...orderDetails,
    });
  } catch (err) {
    const status = err.statusCode || 404;
    return res.status(status).json({
      error: err.message || "Failed to retrieve order.",
      code: err.code || "ADMIN_ORDER_FETCH_FAILED",
    });
  }
});

/**
 * PATCH /api/admin/orders/:orderId/status
 * Requires 'Update Order Fulfillment' permission.
 * Updates order and/or fulfilment status, writes audit log, and records status history.
 */
router.patch("/orders/:orderId/status", requirePermission("Update Order Fulfillment"), handleUpdateOrderStatus);
router.put("/orders/:orderId/status", requirePermission("Update Order Fulfillment"), handleUpdateOrderStatus);
router.post("/orders/:orderId/status", requirePermission("Update Order Fulfillment"), handleUpdateOrderStatus);
router.post("/orders/:orderId/fulfilment", requirePermission("Update Order Fulfillment"), handleUpdateOrderStatus);

async function handleUpdateOrderStatus(req, res) {
  try {
    const updated = await adminUpdateOrderStatus(
      req.params.orderId,
      {
        orderStatus: req.body && (req.body.order_status || req.body.orderStatus),
        fulfilmentStatus: req.body && (req.body.fulfilment_status || req.body.fulfilmentStatus),
        paymentStatus: req.body && (req.body.payment_status !== undefined ? req.body.payment_status : req.body.paymentStatus),
        courierName: req.body && (req.body.courier_name || req.body.courierName),
        trackingNumber: req.body && (req.body.tracking_number || req.body.trackingNumber),
        trackingUrl: req.body && (req.body.tracking_url || req.body.trackingUrl),
        dispatchedAt: req.body && (req.body.dispatched_at || req.body.dispatchedAt),
        notifyCustomer: req.body && (req.body.notify_customer !== undefined ? req.body.notify_customer : req.body.notifyCustomer),
        notes: req.body && req.body.notes,
      },
      req.user,
      req.ip
    );

    return res.json({
      status: "success",
      message: "Order status updated successfully.",
      ...updated,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to update order status.",
      code: err.code || "ADMIN_ORDER_UPDATE_FAILED",
    });
  }
}

/**
 * Dedicated administrative payment verification endpoints.
 * Requires 'Verify Payments' permission (super_operator, artist_divya).
 *
 * Supported paths:
 * - PATCH /api/admin/orders/:orderId/payment-status
 * - POST  /api/admin/orders/:orderId/payment-status
 * - POST  /api/admin/orders/:orderId/verify-payment
 */
router.patch("/orders/:orderId/payment-status", requirePermission("Verify Payments"), handleVerifyPaymentStatus);
router.put("/orders/:orderId/payment-status", requirePermission("Verify Payments"), handleVerifyPaymentStatus);
router.post("/orders/:orderId/payment-status", requirePermission("Verify Payments"), handleVerifyPaymentStatus);
router.post("/orders/:orderId/verify-payment", requirePermission("Verify Payments"), handleVerifyPaymentStatus);

async function handleVerifyPaymentStatus(req, res) {
  try {
    const body = req.body || {};
    const result = await adminVerifyOrderPayment(
      req.params.orderId,
      {
        paymentStatus: body.payment_status || body.paymentStatus,
        paymentMethod: body.payment_method || body.paymentMethod,
        transactionReference: body.transaction_reference || body.transactionReference || body.reference || body.utr,
        amount: body.amount,
        notes: body.notes,
        idempotencyKey: body.idempotency_key || body.idempotencyKey,
      },
      req.user,
      req.ip
    );

    return res.status(200).json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const statusCode = err.statusCode || (err.code === "ORDER_NOT_FOUND" ? 404 : 400);
    return res.status(statusCode).json({
      error: err.message || "Failed to verify order payment.",
      code: err.code || "PAYMENT_VERIFICATION_FAILED",
    });
  }
}

/**
 * POST /api/admin/orders/:orderId/cancel
 * Requires 'Update Order Fulfillment' permission.
 * Cancels eligible orders, creates cancellation history record and audit log.
 */
router.post("/orders/:orderId/cancel", requirePermission("Update Order Fulfillment"), async (req, res) => {
  try {
    const cancelled = await cancelOrder(req.params.orderId, {
      userId: req.user.id,
      isAdmin: true,
      reason: req.body && req.body.reason,
    });

    return res.json({
      status: "success",
      message: "Order cancelled successfully.",
      ...cancelled,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to cancel order.",
      code: err.code || "ADMIN_ORDER_CANCEL_FAILED",
    });
  }
});

// =============================================================================
// 3. APPOINTMENT MANAGEMENT (Delhi NCR)
// =============================================================================

/**
 * GET /api/admin/bookings
 * Requires 'View Bookings' permission.
 * Lists appointment requests with status, date, service, and search filters.
 */
router.get("/bookings", requirePermission("View Bookings"), async (req, res) => {
  try {
    const result = await adminListAppointments({
      status: req.query.status,
      date: req.query.date,
      serviceId: req.query.service_id,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to list appointment requests.",
      code: "ADMIN_BOOKING_LIST_FAILED",
    });
  }
});

/**
 * GET /api/admin/bookings/:bookingId
 * Requires 'View Bookings' permission.
 * Retrieves full appointment details, address, pricing, and complete status history.
 */
router.get("/bookings/:bookingId", requirePermission("View Bookings"), async (req, res) => {
  try {
    const details = await getAppointmentById(req.params.bookingId, {
      isAdmin: true,
      skipAuthCheck: true,
    });

    return res.json({
      status: "success",
      ...details,
    });
  } catch (err) {
    const status = err.statusCode || 404;
    return res.status(status).json({
      error: err.message || "Appointment not found.",
      code: err.code || "ADMIN_BOOKING_FETCH_FAILED",
    });
  }
});

/**
 * PATCH /api/admin/bookings/:bookingId/confirm
 * Requires 'Confirm or Decline Bookings' permission.
 * Confirms an appointment request and locks in scheduled start and end times.
 */
router.patch("/bookings/:bookingId/confirm", requirePermission("Confirm or Decline Bookings"), handleConfirmBooking);
router.post("/bookings/:bookingId/confirm", requirePermission("Confirm or Decline Bookings"), handleConfirmBooking);

async function handleConfirmBooking(req, res) {
  try {
    const result = await confirmAppointmentRequest(
      req.params.bookingId,
      {
        confirmedStartTime: req.body && req.body.confirmed_start_time,
        confirmedEndTime: req.body && req.body.confirmed_end_time,
        notes: req.body && req.body.notes,
      },
      req.user,
      req.ip
    );

    return res.json({
      status: "success",
      message: "Appointment confirmed successfully.",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to confirm appointment request.",
      code: err.code || "ADMIN_CONFIRM_BOOKING_FAILED",
    });
  }
}

/**
 * PATCH /api/admin/bookings/:bookingId/propose-slot
 * Requires 'Confirm or Decline Bookings' permission.
 * Proposes an alternative date & time window when the requested slot is unavailable.
 */
router.patch("/bookings/:bookingId/propose-slot", requirePermission("Confirm or Decline Bookings"), handleProposeSlot);
router.post("/bookings/:bookingId/propose-slot", requirePermission("Confirm or Decline Bookings"), handleProposeSlot);

async function handleProposeSlot(req, res) {
  try {
    const result = await proposeAlternativeSlot(
      req.params.bookingId,
      {
        alternativeDate: req.body && (req.body.alternative_date || req.body.alternative_proposed_date),
        alternativeTimeSlot: req.body && (req.body.alternative_time_slot || req.body.alternative_proposed_time_slot),
        rescheduleReason: req.body && req.body.reschedule_reason,
        notes: req.body && req.body.notes,
      },
      req.user,
      req.ip
    );

    return res.json({
      status: "success",
      message: "Alternative slot proposed to customer.",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to propose alternative slot.",
      code: err.code || "ADMIN_PROPOSE_SLOT_FAILED",
    });
  }
}

/**
 * PATCH /api/admin/bookings/:bookingId/reject
 * Requires 'Confirm or Decline Bookings' permission.
 * Declines an appointment request with an explicit reason.
 */
router.patch("/bookings/:bookingId/reject", requirePermission("Confirm or Decline Bookings"), handleDeclineBooking);
router.post("/bookings/:bookingId/reject", requirePermission("Confirm or Decline Bookings"), handleDeclineBooking);
router.patch("/bookings/:bookingId/decline", requirePermission("Confirm or Decline Bookings"), handleDeclineBooking);
router.post("/bookings/:bookingId/decline", requirePermission("Confirm or Decline Bookings"), handleDeclineBooking);

async function handleDeclineBooking(req, res) {
  try {
    const result = await declineAppointmentRequest(
      req.params.bookingId,
      {
        reason: req.body && (req.body.reason || req.body.decline_reason),
        notes: req.body && req.body.notes,
      },
      req.user,
      req.ip
    );

    return res.json({
      status: "success",
      message: "Appointment request declined.",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to decline appointment request.",
      code: err.code || "ADMIN_DECLINE_BOOKING_FAILED",
    });
  }
}

/**
 * PATCH /api/admin/bookings/:bookingId/cancel
 * Requires 'Confirm or Decline Bookings' permission.
 * Cancels an appointment from the artist/studio side.
 */
router.patch("/bookings/:bookingId/cancel", requirePermission("Confirm or Decline Bookings"), handleCancelBooking);
router.post("/bookings/:bookingId/cancel", requirePermission("Confirm or Decline Bookings"), handleCancelBooking);

async function handleCancelBooking(req, res) {
  try {
    const result = await cancelAppointmentRequest(req.params.bookingId, {
      userId: req.user.id,
      isAdmin: true,
      reason: req.body && req.body.reason,
    });

    return res.json({
      status: "success",
      message: "Appointment cancelled by studio.",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to cancel appointment.",
      code: err.code || "ADMIN_CANCEL_BOOKING_FAILED",
    });
  }
}

/**
 * PATCH /api/admin/bookings/:bookingId/status
 * Requires 'Confirm or Decline Bookings' permission.
 * Updates appointment operational progress (e.g. IN_PROGRESS, COMPLETED).
 */
router.patch("/bookings/:bookingId/status", requirePermission("Confirm or Decline Bookings"), handleUpdateBookingStatus);
router.post("/bookings/:bookingId/status", requirePermission("Confirm or Decline Bookings"), handleUpdateBookingStatus);
router.put("/bookings/:bookingId/status", requirePermission("Confirm or Decline Bookings"), handleUpdateBookingStatus);
router.put("/bookings/:bookingId/progress", requirePermission("Confirm or Decline Bookings"), handleUpdateBookingStatus);
router.post("/bookings/:bookingId/progress", requirePermission("Confirm or Decline Bookings"), handleUpdateBookingStatus);

async function handleUpdateBookingStatus(req, res) {
  try {
    const result = await updateAppointmentStatus(
      req.params.bookingId,
      {
        status: req.body && (req.body.status || req.body.booking_status),
        notes: req.body && req.body.notes,
      },
      req.user,
      req.ip
    );

    return res.json({
      status: "success",
      message: "Appointment status updated.",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to update appointment status.",
      code: err.code || "ADMIN_UPDATE_STATUS_FAILED",
    });
  }
}

// =============================================================================
// 4. CUSTOMER MANAGEMENT
// =============================================================================

/**
 * GET /api/admin/customers
 * Requires 'View Orders' permission.
 * Lists registered customers with search, order/booking metrics, and contact info.
 */
router.get("/customers", requirePermission("View Orders"), async (req, res) => {
  try {
    const result = await listCustomers({
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to list customers.",
      code: "ADMIN_CUSTOMER_LIST_FAILED",
    });
  }
});

/**
 * GET /api/admin/customers/:customerId
 * Requires 'View Orders' permission.
 * Retrieves full customer details: profile, sizing, saved addresses, orders, and bookings.
 */
router.get("/customers/:customerId", requirePermission("View Orders"), async (req, res) => {
  try {
    const result = await getCustomerDetails(req.params.customerId);

    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 404;
    return res.status(status).json({
      error: err.message || "Failed to retrieve customer details.",
      code: err.code || "ADMIN_CUSTOMER_FETCH_FAILED",
    });
  }
});

// =============================================================================
// 5. PRODUCT & SERVICE MANAGEMENT
// =============================================================================

/**
 * GET /api/admin/products
 * Requires 'View Catalog' permission.
 * Lists catalog products with SKU, variants, price, and active status.
 */
router.get("/products", requirePermission("View Catalog"), async (req, res) => {
  try {
    const result = await listAdminProducts({
      category: req.query.category,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to list catalog products.",
      code: "ADMIN_PRODUCT_LIST_FAILED",
    });
  }
});

/**
 * PATCH /api/admin/products/:productId/availability
 * Requires 'Toggle Availability' permission.
 * Toggles product active status and records audit log.
 */
router.patch("/products/:productId/availability", requirePermission("Toggle Availability"), handleToggleProductAvailability);
router.post("/products/:productId/availability", requirePermission("Toggle Availability"), handleToggleProductAvailability);
router.put("/products/:productId/availability", requirePermission("Toggle Availability"), handleToggleProductAvailability);

async function handleToggleProductAvailability(req, res) {
  try {
    const result = await toggleProductAvailability(
      req.params.productId,
      req.body && (req.body.is_active !== undefined ? req.body.is_active : req.body.is_available),
      req.user,
      req.ip
    );

    return res.json({
      status: "success",
      message: "Product availability updated successfully.",
      product: {
        ...result,
        isAvailable: result.is_available,
      },
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to update product availability.",
      code: err.code || "ADMIN_PRODUCT_AVAILABILITY_FAILED",
    });
  }
}

/**
 * POST /api/admin/products
 * Requires 'Edit Catalog Details' permission.
 * Creates a new handcrafted press-on set in the catalog.
 */
router.post("/products", requirePermission("Edit Catalog Details"), async (req, res) => {
  try {
    const product = await createAdminProduct(req.body, req.user, req.ip);
    return res.status(201).json({
      status: "success",
      message: "Product created successfully.",
      product,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to create product.",
      code: err.code || "ADMIN_PRODUCT_CREATE_FAILED",
    });
  }
});

/**
 * PUT /api/admin/products/:productId
 * Requires 'Edit Catalog Details' permission.
 * Updates an existing catalog product.
 */
router.put("/products/:productId", requirePermission("Edit Catalog Details"), handleUpdateProduct);
router.patch("/products/:productId", requirePermission("Edit Catalog Details"), handleUpdateProduct);

async function handleUpdateProduct(req, res) {
  try {
    const product = await updateAdminProduct(req.params.productId, req.body, req.user, req.ip);
    return res.json({
      status: "success",
      message: "Product updated successfully.",
      product,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to update product.",
      code: err.code || "ADMIN_PRODUCT_UPDATE_FAILED",
    });
  }
}

/**
 * POST /api/admin/products/:productId/archive
 * Requires 'Edit Catalog Details' permission.
 * Soft archives a catalog product.
 */
router.post("/products/:productId/archive", requirePermission("Edit Catalog Details"), handleArchiveProduct);
router.delete("/products/:productId", requirePermission("Edit Catalog Details"), handleArchiveProduct);

async function handleArchiveProduct(req, res) {
  try {
    const product = await archiveAdminProduct(req.params.productId, req.user, req.ip);
    return res.json({
      status: "success",
      message: "Product archived successfully.",
      product,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to archive product.",
      code: err.code || "ADMIN_PRODUCT_ARCHIVE_FAILED",
    });
  }
}

/**
 * POST /api/admin/products/:productId/images
 * Requires 'Edit Catalog Details' permission.
 * Adds an image to a product gallery.
 */
router.post("/products/:productId/images", requirePermission("Edit Catalog Details"), async (req, res) => {
  try {
    const image = await addProductImage(req.params.productId, req.body, req.user, req.ip);
    return res.status(201).json({
      status: "success",
      message: "Product image added successfully.",
      image,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to add product image.",
      code: err.code || "ADMIN_PRODUCT_IMAGE_ADD_FAILED",
    });
  }
});

/**
 * DELETE /api/admin/products/:productId/images/:imageId
 * Requires 'Edit Catalog Details' permission.
 * Deletes an image from a product gallery.
 */
router.delete("/products/:productId/images/:imageId", requirePermission("Edit Catalog Details"), async (req, res) => {
  try {
    const result = await deleteProductImage(req.params.productId, req.params.imageId, req.user, req.ip);
    return res.json({
      status: "success",
      message: "Product image deleted successfully.",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to delete product image.",
      code: err.code || "ADMIN_PRODUCT_IMAGE_DELETE_FAILED",
    });
  }
});

// =============================================================================
// PORTFOLIO CMS ENDPOINTS
// =============================================================================

/**
 * GET /api/admin/portfolio
 * Requires 'View Catalog' permission.
 * Lists all portfolio designs for administrative management.
 */
router.get("/portfolio", requirePermission("View Catalog"), async (req, res) => {
  try {
    const result = await listAdminPortfolio({
      category: req.query.category,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to list portfolio artworks.",
      code: "ADMIN_PORTFOLIO_LIST_FAILED",
    });
  }
});

/**
 * POST /api/admin/portfolio
 * Requires 'Edit Catalog Details' permission.
 * Creates a new portfolio design artwork.
 */
router.post("/portfolio", requirePermission("Edit Catalog Details"), async (req, res) => {
  try {
    const artwork = await createAdminPortfolio(req.body, req.user, req.ip);
    return res.status(201).json({
      status: "success",
      message: "Portfolio artwork created successfully.",
      artwork,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to create portfolio artwork.",
      code: err.code || "ADMIN_PORTFOLIO_CREATE_FAILED",
    });
  }
});

/**
 * PUT /api/admin/portfolio/:id
 * Requires 'Edit Catalog Details' permission.
 * Updates an existing portfolio artwork.
 */
router.put("/portfolio/:id", requirePermission("Edit Catalog Details"), handleUpdatePortfolio);
router.patch("/portfolio/:id", requirePermission("Edit Catalog Details"), handleUpdatePortfolio);

async function handleUpdatePortfolio(req, res) {
  try {
    const artwork = await updateAdminPortfolio(req.params.id, req.body, req.user, req.ip);
    return res.json({
      status: "success",
      message: "Portfolio artwork updated successfully.",
      artwork,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to update portfolio artwork.",
      code: err.code || "ADMIN_PORTFOLIO_UPDATE_FAILED",
    });
  }
}

/**
 * PATCH /api/admin/portfolio/:id/availability
 * Requires 'Toggle Availability' permission.
 * Toggles a portfolio design's public active status.
 */
router.patch("/portfolio/:id/availability", requirePermission("Toggle Availability"), async (req, res) => {
  try {
    const isActive = req.body && (req.body.is_active !== undefined ? req.body.is_active : req.body.is_available);
    const artwork = await togglePortfolioAvailability(req.params.id, isActive, req.user, req.ip);
    return res.json({
      status: "success",
      message: "Portfolio artwork availability updated.",
      artwork,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to toggle portfolio availability.",
      code: err.code || "ADMIN_PORTFOLIO_TOGGLE_FAILED",
    });
  }
});

/**
 * DELETE /api/admin/portfolio/:id
 * Requires 'Edit Catalog Details' permission.
 * Deletes a portfolio artwork.
 */
router.delete("/portfolio/:id", requirePermission("Edit Catalog Details"), async (req, res) => {
  try {
    const result = await deleteAdminPortfolio(req.params.id, req.user, req.ip);
    return res.json({
      status: "success",
      message: "Portfolio artwork deleted successfully.",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to delete portfolio artwork.",
      code: err.code || "ADMIN_PORTFOLIO_DELETE_FAILED",
    });
  }
});

// =============================================================================
// REVIEWS MODERATION ENDPOINTS
// =============================================================================

/**
 * GET /api/admin/reviews
 * Requires 'Moderate Customer Reviews' permission.
 * Lists customer reviews with moderation filter: all, pending, approved, rejected.
 */
router.get("/reviews", requirePermission("Moderate Customer Reviews"), async (req, res) => {
  try {
    const result = await adminListReviews({
      status: req.query.status,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to list customer reviews for moderation.",
      code: "ADMIN_REVIEWS_LIST_FAILED",
    });
  }
});

/**
 * PATCH /api/admin/reviews/:id/approve
 * Requires 'Moderate Customer Reviews' permission.
 * Approves a customer review for publication on the public storefront.
 */
router.patch("/reviews/:id/approve", requirePermission("Moderate Customer Reviews"), handleApproveReview);
router.post("/reviews/:id/approve", requirePermission("Moderate Customer Reviews"), handleApproveReview);

async function handleApproveReview(req, res) {
  try {
    const review = await adminModerateReview(
      req.params.id,
      { isApproved: true, notes: req.body && req.body.notes },
      req.user,
      req.ip
    );
    return res.json({
      status: "success",
      message: "Customer review approved and published.",
      review,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to approve review.",
      code: err.code || "ADMIN_REVIEW_APPROVE_FAILED",
    });
  }
}

/**
 * PATCH /api/admin/reviews/:id/reject
 * Requires 'Moderate Customer Reviews' permission.
 * Declines a customer review.
 */
router.patch("/reviews/:id/reject", requirePermission("Moderate Customer Reviews"), handleRejectReview);
router.post("/reviews/:id/reject", requirePermission("Moderate Customer Reviews"), handleRejectReview);

async function handleRejectReview(req, res) {
  try {
    const review = await adminModerateReview(
      req.params.id,
      { isApproved: false, notes: req.body && (req.body.notes || req.body.reason) },
      req.user,
      req.ip
    );
    return res.json({
      status: "success",
      message: "Customer review rejected.",
      review,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to reject review.",
      code: err.code || "ADMIN_REVIEW_REJECT_FAILED",
    });
  }
}

// =============================================================================
// PERSISTENT MEDIA UPLOADS
// =============================================================================

/**
 * Detects image format from binary magic bytes (file signature).
 * Supported: JPEG (FF D8 FF), PNG (89 50 4E 47 0D 0A 1A 0A), WEBP (RIFF....WEBP).
 *
 * @param {Buffer} buf
 * @returns {{ ext: string, mime: string } | null}
 */
function detectImageFormatFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // JPEG signature: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return { ext: "jpg", mime: "image/jpeg" };
  }

  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
    buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A
  ) {
    return { ext: "png", mime: "image/png" };
  }

  // WebP signature: RIFF [4 bytes] WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { ext: "webp", mime: "image/webp" };
  }

  return null;
}

/**
 * POST /api/admin/uploads
 * Requires 'Edit Catalog Details' permission.
 * Uploads an image, validates magic numbers, and stores it in the uploads directory.
 * Returns relative public URL without internal server path exposure.
 */
router.post("/uploads", requirePermission("Edit Catalog Details"), async (req, res) => {
  try {
    const { contentType, content_type, data, image } = req.body || {};

    let clientMime = contentType || content_type;
    let base64Data = data;

    // Handle Data URL (e.g. data:image/png;base64,iVBORw0KGgo...)
    if (image && typeof image === "string") {
      if (image.startsWith("data:")) {
        const match = image.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
        if (match) {
          clientMime = match[1];
          base64Data = match[2];
        } else {
          return res.status(400).json({
            error: "Malformed Data URL format.",
            code: "INVALID_UPLOAD_PAYLOAD",
          });
        }
      } else {
        base64Data = image;
      }
    } else if (typeof data === "string" && data.startsWith("data:")) {
      const match = data.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
      if (match) {
        clientMime = match[1];
        base64Data = match[2];
      } else {
        return res.status(400).json({
          error: "Malformed Data URL format.",
          code: "INVALID_UPLOAD_PAYLOAD",
        });
      }
    }

    if (!base64Data || typeof base64Data !== "string" || !base64Data.trim()) {
      return res.status(400).json({
        error: "Missing image data. Provide Base64-encoded image data or a valid Data URL.",
        code: "INVALID_UPLOAD_PAYLOAD",
      });
    }

    const ALLOWED_MIMES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (clientMime && typeof clientMime === "string") {
      const normalizedClientMime = clientMime.toLowerCase().trim();
      if (!ALLOWED_MIMES.includes(normalizedClientMime)) {
        return res.status(400).json({
          error: "Unsupported image format. Allowed formats: JPEG, PNG, WEBP.",
          code: "UNSUPPORTED_MEDIA_TYPE",
        });
      }
    }

    // Strip whitespace / newlines
    const cleanBase64 = base64Data.replace(/\s+/g, "");

    // Basic Base64 pattern validation
    if (!/^[A-Za-z0-9+/=]+$/.test(cleanBase64) || cleanBase64.length % 4 !== 0) {
      return res.status(400).json({
        error: "Malformed Base64 payload encoding.",
        code: "INVALID_UPLOAD_PAYLOAD",
      });
    }

    let buffer;
    try {
      buffer = Buffer.from(cleanBase64, "base64");
    } catch {
      return res.status(400).json({
        error: "Could not decode Base64 payload.",
        code: "INVALID_UPLOAD_PAYLOAD",
      });
    }

    if (buffer.length < 12) {
      return res.status(400).json({
        error: "Uploaded file payload is empty or too small to be a valid image.",
        code: "INVALID_UPLOAD_PAYLOAD",
      });
    }

    if (buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({
        error: "Image exceeds maximum allowed size of 2MB.",
        code: "FILE_TOO_LARGE",
      });
    }

    // Strictly detect actual binary file signature (magic numbers)
    const detected = detectImageFormatFromBuffer(buffer);
    if (!detected) {
      return res.status(400).json({
        error: "Unsupported or invalid file signature. Allowed formats: JPEG, PNG, WEBP.",
        code: "UNSUPPORTED_MEDIA_TYPE",
      });
    }

    // If client specified MIME type, ensure it matches detected binary format
    if (clientMime && typeof clientMime === "string") {
      const normalizedClientMime = clientMime.toLowerCase().trim();
      const ALLOWED_MIMES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
      if (!ALLOWED_MIMES.includes(normalizedClientMime)) {
        return res.status(400).json({
          error: "Unsupported client MIME type. Allowed formats: JPEG, PNG, WEBP.",
          code: "UNSUPPORTED_MEDIA_TYPE",
        });
      }
      if (
        (detected.ext === "jpg" && !normalizedClientMime.includes("jpeg") && !normalizedClientMime.includes("jpg")) ||
        (detected.ext === "png" && !normalizedClientMime.includes("png")) ||
        (detected.ext === "webp" && !normalizedClientMime.includes("webp"))
      ) {
        return res.status(400).json({
          error: `MIME type mismatch: declared '${clientMime}' but binary signature is '${detected.mime}'.`,
          code: "MIME_TYPE_MISMATCH",
        });
      }
    }

    // Content-addressed filename based strictly on SHA-256 of the validated buffer
    const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const targetFilename = `upload_${hash}.${detected.ext}`;

    const uploadDir = path.resolve(process.cwd(), "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const targetPath = path.resolve(uploadDir, targetFilename);

    // Path traversal defense: Ensure targetPath is strictly inside uploadDir
    if (!targetPath.startsWith(uploadDir) || path.dirname(targetPath) !== uploadDir) {
      return res.status(400).json({
        error: "Invalid target file path.",
        code: "PATH_TRAVERSAL_DETECTED",
      });
    }

    fs.writeFileSync(targetPath, buffer);

    const publicUrl = `/uploads/${targetFilename}`;

    return res.status(201).json({
      status: "success",
      message: "Image uploaded successfully.",
      url: publicUrl,
      filename: targetFilename,
      size: buffer.length,
      mimeType: detected.mime,
    });
  } catch (err) {
    console.error("❌ [Admin Upload Error]:", err.message);
    return res.status(500).json({
      error: "Failed to process image upload.",
      code: "UPLOAD_PROCESSING_ERROR",
    });
  }
});

/**
 * GET /api/admin/services
 * Requires 'View Catalog' permission.
 * Lists salon services with durations, NULL prices for manual quote, and active add-ons.
 */
router.get("/services", requirePermission("View Catalog"), async (req, res) => {
  try {
    const services = await listAdminServices();

    return res.json({
      status: "success",
      services,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to list services.",
      code: "ADMIN_SERVICE_LIST_FAILED",
    });
  }
});

/**
 * PATCH /api/admin/services/:serviceId/availability
 * Requires 'Toggle Availability' permission.
 * Toggles service active status and records audit log.
 */
router.patch("/services/:serviceId/availability", requirePermission("Toggle Availability"), handleToggleServiceAvailability);
router.post("/services/:serviceId/availability", requirePermission("Toggle Availability"), handleToggleServiceAvailability);
router.put("/services/:serviceId/availability", requirePermission("Toggle Availability"), handleToggleServiceAvailability);

async function handleToggleServiceAvailability(req, res) {
  try {
    const result = await toggleServiceAvailability(
      req.params.serviceId,
      req.body && (req.body.is_active !== undefined ? req.body.is_active : req.body.is_available),
      req.user,
      req.ip
    );

    return res.json({
      status: "success",
      message: "Service availability updated successfully.",
      service: result,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to update service availability.",
      code: err.code || "ADMIN_SERVICE_AVAILABILITY_FAILED",
    });
  }
}

// =============================================================================
// 6. STAFF ROLES & PERMISSIONS
// =============================================================================

/**
 * GET /api/admin/staff
 * Requires 'Manage Staff Accounts' permission (super_operator).
 * Lists all staff members with assigned roles and granted permissions.
 */
router.get("/staff", requirePermission("Manage Staff Accounts"), async (req, res) => {
  try {
    const staff = await listStaffAccounts();

    return res.json({
      status: "success",
      staff,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to list staff accounts.",
      code: "ADMIN_STAFF_LIST_FAILED",
    });
  }
});

/**
 * GET /api/admin/roles
 * Requires 'View Catalog' or 'View Orders' permission.
 * Returns role definitions and permission mappings.
 */
router.get("/roles", requirePermission("View Catalog"), async (req, res) => {
  try {
    const matrix = await getRolePermissionMatrix();

    return res.json({
      status: "success",
      ...matrix,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to retrieve roles matrix.",
      code: "ADMIN_ROLES_FETCH_FAILED",
    });
  }
});

// =============================================================================
// 7. BUSINESS SETTINGS & AUDIT LOGS
// =============================================================================

/**
 * GET /api/admin/settings
 * Requires 'View Catalog' permission.
 * Lists operational business settings.
 */
router.get("/settings", requirePermission("View Catalog"), async (req, res) => {
  try {
    const settings = await listBusinessSettings();

    return res.json({
      status: "success",
      settings,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to list business settings.",
      code: "ADMIN_SETTINGS_FETCH_FAILED",
    });
  }
});

/**
 * GET /api/admin/audit-logs
 * Requires 'View Audit Logs' permission (super_operator).
 * Lists immutable audit log trail with pagination and filters.
 */
router.get("/audit-logs", requirePermission("View Audit Logs"), async (req, res) => {
  try {
    const result = await listAuditLogs({
      limit: req.query.limit,
      offset: req.query.offset,
      action: req.query.action,
      targetEntity: req.query.target_entity,
    });

    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to list audit logs.",
      code: "ADMIN_AUDIT_LOGS_FAILED",
    });
  }
});

// =============================================================================
// 8. COMMUNICATIONS & NOTIFICATIONS TELEMETRY
// =============================================================================

/**
 * GET /api/admin/communications/notifications
 * Requires 'View Orders' permission.
 * Lists notification queue, provider delivery status, and operator fallback WhatsApp links.
 */
router.get("/communications/notifications", requirePermission("View Orders"), async (req, res) => {
  try {
    const filters = {
      status: req.query.status,
      channel: req.query.channel,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    };

    const result = await listNotifications(filters);

    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to retrieve notifications.",
      code: "ADMIN_NOTIFICATIONS_FETCH_FAILED",
    });
  }
});

/**
 * POST /api/admin/communications/notifications/:id/retry
 * Requires 'Update Order Fulfillment' permission.
 * Retries a failed or queued notification job immediately.
 */
router.post("/communications/notifications/:id/retry", requirePermission("Update Order Fulfillment"), async (req, res) => {
  try {
    const updatedJob = await retryNotification(req.params.id, req.user);

    return res.json({
      status: "success",
      message: "Notification retry dispatched.",
      notification: updatedJob,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to retry notification.",
      code: "ADMIN_NOTIFICATION_RETRY_FAILED",
    });
  }
});

/**
 * GET /api/admin/analytics/summary
 * Protected: requires admin authentication (artist_divya or super_operator).
 * Retrieves daily aggregated privacy-safe operational event metrics.
 */
router.get("/analytics/summary", async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 14;
    const history = await getDailyAnalytics(days);
    return res.json({
      status: "success",
      days,
      analytics: history,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Failed to retrieve analytics summary.",
      code: "ANALYTICS_QUERY_FAILED",
    });
  }
});

module.exports = router;
