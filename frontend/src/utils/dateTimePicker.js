const pad = (value) => String(value).padStart(2, "0");

export function parseLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;

  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }
  return date;
}

export function toLocalDateTimeValue(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "";
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
    value.getDate(),
  )}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

export function toLocalDateKey(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "";
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function formatDateTimeDisplay(value) {
  const date = parseLocalDateTime(value);
  if (!date) return "Chọn ngày và giờ";
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} • ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function buildCalendarDays(year, month) {
  const firstDay = new Date(year, month, 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const firstCell = new Date(year, month, 1 - mondayOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(
      firstCell.getFullYear(),
      firstCell.getMonth(),
      firstCell.getDate() + index,
    );
    return {
      date,
      dateKey: toLocalDateKey(date),
      day: date.getDate(),
      inCurrentMonth: date.getMonth() === month,
    };
  });
}

export function getYearOptions(selectedYear, currentYear = new Date().getFullYear()) {
  const start = Math.min(currentYear - 10, selectedYear);
  const end = Math.max(currentYear + 20, selectedYear);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function clampToMinimum(value, minimum) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return value;
  if (!(minimum instanceof Date) || Number.isNaN(minimum.getTime())) {
    return new Date(value);
  }
  return new Date(Math.max(value.getTime(), minimum.getTime()));
}
