import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCalendarDays,
  clampToMinimum,
  formatDateTimeDisplay,
  getYearOptions,
  parseLocalDateTime,
  toLocalDateTimeValue,
} from "./dateTimePicker.js";

test("parses and formats local datetime values without timezone drift", () => {
  const date = parseLocalDateTime("2026-08-08T14:05");
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 7);
  assert.equal(date.getDate(), 8);
  assert.equal(date.getHours(), 14);
  assert.equal(date.getMinutes(), 5);
  assert.equal(toLocalDateTimeValue(date), "2026-08-08T14:05");
  assert.equal(formatDateTimeDisplay("2026-08-08T14:05"), "08/08/2026 • 14:05");
});

test("builds a Monday-first six-week calendar including adjacent days", () => {
  const days = buildCalendarDays(2026, 7);
  assert.equal(days.length, 42);
  assert.equal(days[0].dateKey, "2026-07-27");
  assert.equal(days[5].dateKey, "2026-08-01");
  assert.equal(days[41].dateKey, "2026-09-06");
  assert.equal(days[5].inCurrentMonth, true);
  assert.equal(days[0].inCurrentMonth, false);
});

test("year options remain easy to select and always include the active year", () => {
  const defaultYears = getYearOptions(2026, 2026);
  assert.equal(defaultYears[0], 2016);
  assert.equal(defaultYears.at(-1), 2046);
  assert.ok(getYearOptions(2055, 2026).includes(2055));
});

test("clamps a selected datetime to the configured minimum", () => {
  const minimum = parseLocalDateTime("2026-08-10T09:30");
  assert.equal(
    toLocalDateTimeValue(
      clampToMinimum(parseLocalDateTime("2026-08-09T20:00"), minimum),
    ),
    "2026-08-10T09:30",
  );
  assert.equal(
    toLocalDateTimeValue(
      clampToMinimum(parseLocalDateTime("2026-08-10T10:00"), minimum),
    ),
    "2026-08-10T10:00",
  );
});

test("rejects invalid local datetime values", () => {
  assert.equal(parseLocalDateTime(""), null);
  assert.equal(parseLocalDateTime("2026-02-31T12:00"), null);
  assert.equal(formatDateTimeDisplay("invalid"), "Chọn ngày và giờ");
});
