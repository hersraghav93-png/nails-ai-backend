/**
 * ==============================================================================
 * NOTIFICATION TEMPLATES (`src/services/notifications/notificationTemplates.js`)
 * Nails by Divya Platform — Phase 3A Customer Communications
 *
 * Provides standardized, brand-aligned WhatsApp & SMS message templates.
 * Separates copy, token substitution, and manual fallback generation from core
 * business workflows.
 * ==============================================================================
 */

"use strict";

/**
 * Normalizes phone numbers to standard E.164 format or stripped digits for wa.me links.
 * @param {string} phone
 * @returns {string} E.164 digits without plus (e.g. 919811000001)
 */
function toWaDigits(phone) {
  if (!phone) return "";
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) {
    digits = "91" + digits.slice(1);
  } else if (digits.length === 10) {
    digits = "91" + digits; // Default India prefix if omitted
  }
  return digits;
}

/**
 * Formats a currency amount into standard Indian Rupee notation (e.g. "₹599.00").
 * @param {number|string} amount
 * @returns {string}
 */
function formatInr(amount) {
  const num = parseFloat(amount);
  if (isNaN(num)) return "₹0.00";
  return `₹${num.toFixed(2)}`;
}

/**
 * Dictionary of verified template generators.
 */
const TEMPLATES = {
  // ============================================================================
  // ORDER COMMUNICATIONS
  // ============================================================================

  ORDER_CONFIRMED: {
    name: "order_confirmed",
    render(vars = {}) {
      const customerName = vars.customerName || "Valued Client";
      const orderNumber = vars.orderNumber || "Pending";
      const items = vars.itemsSummary || "Custom Press-on Nails";
      const total = formatInr(vars.totalAmount);
      const address = vars.deliveryAddress || "Standard Delivery";

      return [
        `🌸 *Nails by Divya — Order Confirmed* 🌸`,
        ``,
        `Hi ${customerName}! Thank you for your order. We have received your order details and are preparing to craft your bespoke sets.`,
        ``,
        `📋 *Order Number:* ${orderNumber}`,
        `💅 *Items:* ${items}`,
        `💰 *Total Amount:* ${total}`,
        `📍 *Delivery Address:* ${address}`,
        ``,
        `Each press-on set is handcrafted with salon-grade builder gel and tailored to your nail measurements. We will notify you once production begins!`,
        ``,
        `— Nails by Divya Studio (Delhi NCR)`,
      ].join("\n");
    },
  },

  ORDER_IN_PRODUCTION: {
    name: "order_in_production",
    render(vars = {}) {
      const customerName = vars.customerName || "Valued Client";
      const orderNumber = vars.orderNumber || "Pending";

      return [
        `✨ *Nails by Divya — Order in Production* ✨`,
        ``,
        `Hi ${customerName}! Great news — order *${orderNumber}* is now being handcrafted by lead artist Divya.`,
        ``,
        `Your nail sizing specifications are currently being shaped, structured, and cured with professional finishes.`,
        ``,
        `We will notify you as soon as quality inspection is complete and your parcel is prepared for dispatch!`,
        ``,
        `— Nails by Divya Studio`,
      ].join("\n");
    },
  },

  ORDER_READY_FOR_DISPATCH: {
    name: "order_ready_for_dispatch",
    render(vars = {}) {
      const customerName = vars.customerName || "Valued Client";
      const orderNumber = vars.orderNumber || "Pending";

      return [
        `📦 *Nails by Divya — Ready for Dispatch* 📦`,
        ``,
        `Hi ${customerName}! Your press-on nail sets for order *${orderNumber}* are complete, quality-checked, and safely packaged with your application kit.`,
        ``,
        `Our courier partner will pick up your shipment shortly. We will share your tracking number the moment it is scanned!`,
        ``,
        `— Nails by Divya Studio`,
      ].join("\n");
    },
  },

  ORDER_DISPATCHED: {
    name: "order_dispatched",
    render(vars = {}) {
      const customerName = vars.customerName || "Valued Client";
      const orderNumber = vars.orderNumber || "Pending";
      const courier = vars.courierName || "Express Courier";
      const tracking = vars.trackingNumber || "Pending Assignment";
      const trackingUrl = vars.trackingUrl ? `🔗 *Track Shipment:* ${vars.trackingUrl}\n` : "";
      const date = vars.dispatchedDate || new Date().toLocaleDateString("en-IN");

      return [
        `🚀 *Nails by Divya — Order Dispatched* 🚀`,
        ``,
        `Hi ${customerName}! Your order *${orderNumber}* is on its way to you!`,
        ``,
        `🚚 *Courier Partner:* ${courier}`,
        `🔢 *Tracking / AWB Number:* ${tracking}`,
        trackingUrl + `📅 *Dispatched on:* ${date}`,
        ``,
        `Please ensure your phone is accessible for the delivery partner. We hope you love wearing your new nails!`,
        ``,
        `— Nails by Divya Studio`,
      ].join("\n");
    },
  },

  ORDER_DELIVERED: {
    name: "order_delivered",
    render(vars = {}) {
      const customerName = vars.customerName || "Valued Client";
      const orderNumber = vars.orderNumber || "Pending";

      return [
        `🎉 *Nails by Divya — Delivered* 🎉`,
        ``,
        `Hi ${customerName}! Order *${orderNumber}* has been marked as delivered.`,
        ``,
        `Inside your package, you will find your nail sets, salon adhesive tabs, liquid glue, buffer, and wooden cuticle pusher.`,
        ``,
        `Tag us on Instagram @nailsbydivya with your fresh set! If you need any assistance with application or removal, simply reply to this message.`,
        ``,
        `— Nails by Divya Studio`,
      ].join("\n");
    },
  },

  ORDER_CANCELLED: {
    name: "order_cancelled",
    render(vars = {}) {
      const customerName = vars.customerName || "Valued Client";
      const orderNumber = vars.orderNumber || "Pending";
      const reason = vars.cancellationReason || "Customer request";

      return [
        `⚠️ *Nails by Divya — Order Cancelled*`,
        ``,
        `Hi ${customerName}. This is to notify you that order *${orderNumber}* has been cancelled.`,
        ``,
        `*Reason:* ${reason}`,
        ``,
        `If this cancellation was in error or you require refund assistance, please reply directly to this message.`,
        ``,
        `— Nails by Divya Studio`,
      ].join("\n");
    },
  },

  // ============================================================================
  // AT-HOME APPOINTMENT COMMUNICATIONS
  // ============================================================================

  APPOINTMENT_REQUESTED: {
    name: "appointment_requested",
    render(vars = {}) {
      const customerName = vars.customerName || "Valued Client";
      const bookingNumber = vars.bookingNumber || "Pending";
      const serviceName = vars.serviceName || "At-Home Nail Service";
      const reqDate = vars.requestedDate || "Requested Date";
      const reqSlot = vars.requestedTimeSlot || "Preferred Time";
      const address = vars.serviceAddress || "Delhi NCR";

      return [
        `🗓️ *Nails by Divya — Appointment Request Received*`,
        ``,
        `Hi ${customerName}! We have received your at-home service request.`,
        ``,
        `📋 *Booking Reference:* ${bookingNumber}`,
        `💅 *Service:* ${serviceName}`,
        `📅 *Requested Schedule:* ${reqDate} (${reqSlot})`,
        `📍 *Location:* ${address}`,
        ``,
        `Our lead artist Divya is reviewing studio scheduling for your locality. We operate on a personalized review model and will confirm or propose an available time window shortly.`,
        ``,
        `— Nails by Divya Concierge`,
      ].join("\n");
    },
  },

  APPOINTMENT_CONFIRMED: {
    name: "appointment_confirmed",
    render(vars = {}) {
      const customerName = vars.customerName || "Valued Client";
      const bookingNumber = vars.bookingNumber || "Pending";
      const serviceName = vars.serviceName || "At-Home Nail Service";
      const date = vars.confirmedDate || "Scheduled Date";
      const slot = vars.confirmedSlot || "Confirmed Time";
      const address = vars.serviceAddress || "Your Address";

      return [
        `✨ *Nails by Divya — Appointment CONFIRMED* ✨`,
        ``,
        `Hi ${customerName}! Your at-home nail service appointment is confirmed!`,
        ``,
        `📋 *Booking Reference:* ${bookingNumber}`,
        `💅 *Service:* ${serviceName}`,
        `📅 *Confirmed Date & Time:* ${date} (${slot})`,
        `📍 *Service Address:* ${address}`,
        ``,
        `Our artist will arrive with all sterilized tools, builder gels, and professional curing lamps. Please ensure a flat table and standard power outlet are accessible.`,
        ``,
        `— Nails by Divya Concierge`,
      ].join("\n");
    },
  },

  APPOINTMENT_ALTERNATIVE_PROPOSED: {
    name: "appointment_alternative_proposed",
    render(vars = {}) {
      const customerName = vars.customerName || "Valued Client";
      const bookingNumber = vars.bookingNumber || "Pending";
      const propDate = vars.proposedDate || "Alternative Date";
      const propSlot = vars.proposedSlot || "Alternative Time";
      const reason = vars.rescheduleReason || "Studio schedule conflict";

      return [
        `🔄 *Nails by Divya — Alternative Slot Proposed*`,
        ``,
        `Hi ${customerName}. Regarding appointment request *${bookingNumber}*:`,
        ``,
        `Lead artist Divya is unavailable at your originally requested slot, but has reserved this alternative slot for you:`,
        `📅 *Proposed Slot:* ${propDate} (${propSlot})`,
        `💬 *Note:* ${reason}`,
        ``,
        `Please reply to this message to confirm this alternative time, or let us know another time that works best for you!`,
        ``,
        `— Nails by Divya Concierge`,
      ].join("\n");
    },
  },

  APPOINTMENT_DECLINED: {
    name: "appointment_declined",
    render(vars = {}) {
      const customerName = vars.customerName || "Valued Client";
      const bookingNumber = vars.bookingNumber || "Pending";
      const reason = vars.declineReason || "Outside service coverage perimeter";

      return [
        `ℹ️ *Nails by Divya — Appointment Request Update*`,
        ``,
        `Hi ${customerName}. Regarding booking request *${bookingNumber}*:`,
        ``,
        `We regret that we are unable to accommodate this appointment request at this time.`,
        `*Reason:* ${reason}`,
        ``,
        `We apologize for any inconvenience. You are always welcome to explore our ready-to-wear luxury press-on collections delivered anywhere across India!`,
        ``,
        `— Nails by Divya Concierge`,
      ].join("\n");
    },
  },

  APPOINTMENT_CANCELLED: {
    name: "appointment_cancelled",
    render(vars = {}) {
      const customerName = vars.customerName || "Valued Client";
      const bookingNumber = vars.bookingNumber || "Pending";
      const reason = vars.cancellationReason || "Scheduling adjustment";

      return [
        `⚠️ *Nails by Divya — Appointment Cancelled*`,
        ``,
        `Hi ${customerName}. Appointment *${bookingNumber}* has been cancelled.`,
        `*Reason:* ${reason}`,
        ``,
        `If you would like to reschedule or have questions, please reach out directly via WhatsApp.`,
        ``,
        `— Nails by Divya Concierge`,
      ].join("\n");
    },
  },
};

/**
 * Renders template content and creates a manual WhatsApp fallback link.
 *
 * @param {string} templateKey Key in TEMPLATES
 * @param {object} variables Template parameters
 * @param {string} recipientPhone Recipient mobile number (E.164)
 * @returns {{ text: string, templateName: string, waLink: string }}
 */
function renderTemplate(templateKey, variables = {}, recipientPhone = "") {
  const tpl = TEMPLATES[templateKey];
  if (!tpl) {
    throw new Error(`Unknown notification template: "${templateKey}".`);
  }

  const text = tpl.render(variables);
  const waDigits = toWaDigits(recipientPhone);
  const waLink = waDigits ? `https://wa.me/${waDigits}?text=${encodeURIComponent(text)}` : "";

  return {
    templateKey,
    templateName: tpl.name,
    text,
    waLink,
  };
}

module.exports = {
  TEMPLATES,
  renderTemplate,
  toWaDigits,
  formatInr,
};
