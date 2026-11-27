"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { getBookingSchedule, validateRequestedDate, validateTimeSlot, validateConfirmation } =
  require("../src/services/bookingSchedule");

const now = new Date("2026-11-27T07:00:00Z");

test("public schedule includes only the existing in-hours windows", () => {
  const schedule = getBookingSchedule(now);
  assert.equal(schedule.timeZone, "Asia/Kolkata");
  assert.equal(schedule.opensAt, "12:00");
  assert.equal(schedule.closesAt, "18:00");
  assert.deepEqual(schedule.openWeekdays, [2, 3, 4, 5, 6, 0]);
  assert.deepEqual(schedule.requestWindows, ["12:30 PM - 02:30 PM", "03:00 PM - 05:00 PM"]);
  for (const slot of schedule.requestWindows) assert.equal(validateTimeSlot(slot), slot);
  for (const slot of ["10:00 AM - 12:00 PM", "05:30 PM - 07:30 PM", "afternoon", "12:00 - 18:00", 12]) {
    assert.throws(() => validateTimeSlot(slot), { code: "INVALID_TIME_SLOT" });
  }
});

test("Sunday, Monday, two calendar days and the inclusive 60-day horizon", () => {
  assert.throws(() => validateRequestedDate("2026-11-28", { now }), { code: "MINIMUM_NOTICE_REQUIRED" });
  assert.equal(validateRequestedDate("2026-11-29", { now }), "2026-11-29");
  assert.throws(() => validateRequestedDate("2026-11-30", { now }), { code: "STUDIO_CLOSED" });
  assert.equal(validateRequestedDate("2027-01-26", { now }), "2027-01-26");
  assert.throws(() => validateRequestedDate("2027-01-27", { now }), { code: "DATE_TOO_FAR_IN_ADVANCE" });
  assert.throws(() => validateRequestedDate("2026-11-31", { now }), { code: "INVALID_DATE" });
  assert.throws(() => validateRequestedDate("2026-11-29T00:00:00Z", { now }), { code: "INVALID_DATE_FORMAT" });
});

test("booking eligibility rolls over at Delhi midnight on hosts in other timezones", () => {
  const before = "2026-11-27T18:29:59Z";
  const after = "2026-11-27T18:30:00Z";
  assert.equal(getBookingSchedule(new Date(before)).earliestDate, "2026-11-29");
  assert.equal(getBookingSchedule(new Date(after)).earliestDate, "2026-11-30");
  assert.throws(() => validateRequestedDate("2026-11-29", { now: new Date(after) }), {
    code: "MINIMUM_NOTICE_REQUIRED",
  });
  for (const TZ of ["America/Los_Angeles", "Pacific/Auckland"]) {
    const result = spawnSync(process.execPath, ["-p",
      'require("./src/services/bookingSchedule").getBookingSchedule(new Date("' + after + '")).today',
    ], { cwd: __dirname + "/..", env: { ...process.env, TZ }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "2026-11-28");
  }
});

test("regular confirmation permits exactly noon and 6 PM, with an explicit timezone", () => {
  const confirm = (start, end) => validateConfirmation(start, end, {}, false, now);
  assert.equal(confirm("2026-11-29T12:00:00+05:30", "2026-11-29T18:00:00+05:30").day, "2026-11-29");
  assert.throws(() => confirm("2026-11-29T11:59:59+05:30", "2026-11-29T18:00:00+05:30"), {
    code: "INVALID_CONFIRMED_TIME",
  });
  assert.throws(() => confirm("2026-11-29T12:00:00+05:30", "2026-11-29T18:00:01+05:30"), {
    code: "INVALID_CONFIRMED_TIME",
  });
  assert.throws(() => confirm("2026-11-29T12:00:00", "2026-11-29T18:00:00"), {
    code: "INVALID_CONFIRMED_TIME",
  });
});

test("only an explicitly accepted, staff-proposed window can be confirmed outside hours", () => {
  const proposal = {
    booking_status: "ALTERNATIVE_PROPOSED", reschedule_reason: "Staff schedule exception: Fixture",
    alternative_proposed_date: "2026-11-30", alternative_proposed_time_slot: "10:00 - 11:00",
  };
  const start = "2026-11-30T10:00:00+05:30";
  const end = "2026-11-30T11:00:00+05:30";
  assert.throws(() => validateConfirmation(start, end, {}, true, now), { code: "STUDIO_CLOSED" });
  assert.throws(() => validateConfirmation(start, end, proposal, false, now), {
    code: "EXCEPTION_REQUIRES_ACCEPTANCE",
  });
  assert.equal(validateConfirmation(start, end, proposal, true, now).exception, true);
  assert.throws(() => validateConfirmation(start, "2026-11-30T11:30:00+05:30", proposal, true, now), {
    code: "EXCEPTION_REQUIRES_ACCEPTANCE",
  });
  assert.throws(() => validateTimeSlot("20:00 - 03:00", { exception: true }), { code: "INVALID_TIME_SLOT" });
});
