"use strict";

const timeZone = "Asia/Kolkata";
const openWeekdays = Object.freeze([2, 3, 4, 5, 6, 0]);
const opensAt = "12:00";
const closesAt = "18:00";
const minNoticeDays = 2;
const maxAdvanceDays = 60;
const requestWindows = Object.freeze([
  "12:30 PM - 02:30 PM",
  "03:00 PM - 05:00 PM",
]);
const exceptionPrefix = "Staff schedule exception: ";
const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short" });
const clockFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function scheduleError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}

function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw scheduleError("INVALID_DATE_FORMAT", "Choose a date in YYYY-MM-DD format.");
  }
  // UTC is only a calendar arithmetic frame. Studio dates come from Delhi time.
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw scheduleError("INVALID_DATE", "Choose a valid calendar date.");
  }
  return date;
}

function shiftDate(day, days) {
  const date = calendarDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getBookingSchedule(now = new Date()) {
  const today = dateFormat.format(now);
  return {
    timeZone, openWeekdays, opensAt, closesAt, minNoticeDays, maxAdvanceDays,
    today, earliestDate: shiftDate(today, minNoticeDays), latestDate: shiftDate(today, maxAdvanceDays),
    requestWindows,
  };
}

function validateRequestedDate(value, { now = new Date(), staff = false, exception = false } = {}) {
  const date = calendarDate(value);
  const { today, earliestDate, latestDate } = getBookingSchedule(now);
  if (value < today) {
    throw scheduleError("PAST_DATE_NOT_ALLOWED", "Appointments must be on an upcoming Delhi calendar date.");
  }
  if (value > latestDate) {
    throw scheduleError("DATE_TOO_FAR_IN_ADVANCE", `Appointments can be requested up to ${maxAdvanceDays} days ahead.`);
  }
  if (!staff && value < earliestDate) {
    throw scheduleError("MINIMUM_NOTICE_REQUIRED", `Please give at least ${minNoticeDays} calendar days’ notice.`);
  }
  if (!exception && !openWeekdays.includes(date.getUTCDay())) {
    throw scheduleError("STUDIO_CLOSED", "The studio is closed on Mondays. Please choose Tuesday through Sunday.");
  }
  return value;
}

function parseWindow(value) {
  const slot = typeof value === "string" ? value.trim() : "";
  const clock24 = /^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/.exec(slot);
  const clock12 = /^(0?[1-9]|1[0-2]):([0-5]\d)\s(AM|PM)\s*-\s*(0?[1-9]|1[0-2]):([0-5]\d)\s(AM|PM)$/i.exec(slot);
  const as24 = (hour, minute, period) => `${String((Number(hour) % 12) + (period.toUpperCase() === "PM" ? 12 : 0)).padStart(2, "0")}:${minute}`;
  const start = clock24 ? `${clock24[1]}:${clock24[2]}` : clock12 && as24(...clock12.slice(1, 4));
  const end = clock24 ? `${clock24[3]}:${clock24[4]}` : clock12 && as24(...clock12.slice(4, 7));
  if (!start || !end || start >= end) {
    throw scheduleError("INVALID_TIME_SLOT", "Choose a valid same-day time window with the end after the start.");
  }
  return { start, end };
}

function validateTimeSlot(value, { exception = false } = {}) {
  const slot = typeof value === "string" ? value.trim() : "";
  if (exception) {
    const { start, end } = parseWindow(slot);
    return `${start} - ${end}`;
  }
  if (!requestWindows.includes(slot)) {
    throw scheduleError("INVALID_TIME_SLOT", "Choose one of the available Delhi appointment request windows.");
  }
  return slot;
}

function validateConfirmation(startValue, endValue, booking, customerAcceptedException, now = new Date()) {
  const explicitInstant = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (![startValue, endValue].every((value) => typeof value === "string" && explicitInstant.test(value)) ||
      !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start <= now || end <= start) {
    throw scheduleError("INVALID_CONFIRMED_TIME", "Enter valid, upcoming start and end times in Delhi time.");
  }
  calendarDate(startValue.slice(0, 10));
  calendarDate(endValue.slice(0, 10));
  const day = dateFormat.format(start);
  const opening = new Date(`${day}T${opensAt}:00+05:30`);
  const closing = new Date(`${day}T${closesAt}:00+05:30`);
  const exception = booking.reschedule_reason?.startsWith(exceptionPrefix) &&
    booking.booking_status === "ALTERNATIVE_PROPOSED";
  if (exception) {
    const proposed = parseWindow(booking.alternative_proposed_time_slot);
    const proposedDay = booking.alternative_proposed_date;
    const from = new Date(`${proposedDay}T${proposed.start}:00+05:30`);
    const until = new Date(`${proposedDay}T${proposed.end}:00+05:30`);
    if (customerAcceptedException !== true || !(start >= from && end <= until)) {
      throw scheduleError("EXCEPTION_REQUIRES_ACCEPTANCE", "Confirm the customer accepted the proposed exception and keep the appointment within that window.");
    }
  } else {
    validateRequestedDate(day, { now, staff: true });
    if (start < opening || end > closing) {
      throw scheduleError("INVALID_CONFIRMED_TIME", "Confirm within studio operating hours or propose a schedule exception first.");
    }
  }
  return { start, end, day, exception: Boolean(exception) };
}

function formatDelhiClock(date) {
  return clockFormat.format(date);
}

module.exports = {
  getBookingSchedule, validateRequestedDate, validateTimeSlot, validateConfirmation,
  scheduleError, exceptionPrefix, formatDelhiClock, timeZone,
};
