"use strict";

const { getBookingSchedule } = require("../src/services/bookingSchedule");

function openDate(daysAhead = 3) {
  const schedule = getBookingSchedule();
  const date = new Date(schedule.today + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + daysAhead);
  while (!schedule.openWeekdays.includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

module.exports = { openDate };
