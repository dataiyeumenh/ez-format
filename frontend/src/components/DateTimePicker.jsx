import { useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  X,
} from "lucide-react";
import {
  buildCalendarDays,
  clampToMinimum,
  formatDateTimeDisplay,
  getYearOptions,
  parseLocalDateTime,
  toLocalDateKey,
  toLocalDateTimeValue,
} from "../utils/dateTimePicker";

const MONTHS = Array.from({ length: 12 }, (_, index) => `Tháng ${index + 1}`);
const WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
const HOURS = Array.from({ length: 24 }, (_, index) => index);
const MINUTES = Array.from({ length: 60 }, (_, index) => index);

function roundedNow() {
  const value = new Date();
  value.setSeconds(0, 0);
  return value;
}

function DateTimePicker({
  value,
  onChange,
  min,
  disabled = false,
  required = false,
  className = "",
  ariaLabel = "Chọn ngày và giờ",
}) {
  const monthSelectRef = useRef(null);
  const minimum = useMemo(() => parseLocalDateTime(min), [min]);
  const initialDate = () =>
    clampToMinimum(parseLocalDateTime(value) || minimum || roundedNow(), minimum);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initialDate);
  const [viewYear, setViewYear] = useState(() => initialDate().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => initialDate().getMonth());

  const calendarDays = useMemo(
    () => buildCalendarDays(viewYear, viewMonth),
    [viewMonth, viewYear],
  );
  const yearOptions = useMemo(() => getYearOptions(viewYear), [viewYear]);
  const selectedKey = toLocalDateKey(draft);
  const todayKey = toLocalDateKey(new Date());
  const minimumKey = minimum ? toLocalDateKey(minimum) : "";

  const initializeDraft = () => {
    const next = initialDate();
    setDraft(next);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const handleOpenChange = (nextOpen) => {
    if (nextOpen) initializeDraft();
    setOpen(nextOpen);
  };

  const moveMonth = (delta) => {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const selectDate = (day) => {
    if (minimumKey && day.dateKey < minimumKey) return;
    const next = new Date(day.date);
    next.setHours(draft.getHours(), draft.getMinutes(), 0, 0);
    const clamped = clampToMinimum(next, minimum);
    setDraft(clamped);
    setViewYear(clamped.getFullYear());
    setViewMonth(clamped.getMonth());
  };

  const setTimePart = (part, nextValue) => {
    const next = new Date(draft);
    if (part === "hour") next.setHours(nextValue);
    else next.setMinutes(nextValue);
    setDraft(clampToMinimum(next, minimum));
  };

  const adjustTimePart = (part, delta) => {
    const current = part === "hour" ? draft.getHours() : draft.getMinutes();
    const limit = part === "hour" ? 24 : 60;
    setTimePart(part, (current + delta + limit) % limit);
  };

  const chooseToday = () => {
    const next = clampToMinimum(roundedNow(), minimum);
    setDraft(next);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const apply = () => {
    onChange(toLocalDateTimeValue(clampToMinimum(draft, minimum)));
    setOpen(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <div className="relative">
        <Dialog.Trigger asChild>
          <input
            type="text"
            readOnly
            required={required}
            disabled={disabled}
            value={formatDateTimeDisplay(value)}
            aria-label={ariaLabel}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={`${className} cursor-pointer pr-11 disabled:cursor-not-allowed`}
          />
        </Dialog.Trigger>
        <CalendarClock
          size={18}
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
        />
      </div>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-slate-950/45 backdrop-blur-[2px]" />
        <Dialog.Content
          role="dialog"
          aria-modal="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            monthSelectRef.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-[80] max-h-[calc(100vh-1.5rem)] w-[calc(100%-1.5rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white shadow-2xl outline-none"
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                <CalendarClock size={18} />
              </span>
              <div>
                <Dialog.Title className="text-sm font-bold text-slate-900">
                  Chọn ngày và giờ
                </Dialog.Title>
                <Dialog.Description className="text-xs text-slate-400">
                  Giờ Việt Nam, định dạng 24 giờ
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Đóng bộ chọn ngày giờ"
                className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>

          <div className="grid md:grid-cols-[1.25fr_0.75fr]">
            <section className="p-4 sm:p-5" aria-label="Lịch">
              <div className="mb-4 flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Tháng trước"
                  onClick={() => moveMonth(-1)}
                  className="rounded-lg border border-slate-200 p-2 text-slate-600 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <ChevronLeft size={17} />
                </button>
                <select
                  ref={monthSelectRef}
                  aria-label="Chọn tháng"
                  value={viewMonth}
                  onChange={(event) => setViewMonth(Number(event.target.value))}
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm font-semibold text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
                >
                  {MONTHS.map((month, index) => (
                    <option key={month} value={index}>
                      {month}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Chọn năm"
                  value={viewYear}
                  onChange={(event) => setViewYear(Number(event.target.value))}
                  className="w-24 rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm font-bold text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
                >
                  {yearOptions.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label="Tháng sau"
                  onClick={() => moveMonth(1)}
                  className="rounded-lg border border-slate-200 p-2 text-slate-600 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <ChevronRight size={17} />
                </button>
              </div>

              <div className="grid grid-cols-7 text-center">
                {WEEKDAYS.map((weekday) => (
                  <span
                    key={weekday}
                    className="py-2 text-[11px] font-semibold text-slate-400"
                  >
                    {weekday}
                  </span>
                ))}
                {calendarDays.map((day) => {
                  const selected = day.dateKey === selectedKey;
                  const today = day.dateKey === todayKey;
                  const unavailable = Boolean(minimumKey && day.dateKey < minimumKey);
                  return (
                    <button
                      key={day.dateKey}
                      type="button"
                      disabled={unavailable}
                      aria-label={day.dateKey}
                      aria-pressed={selected}
                      onClick={() => selectDate(day)}
                      className={`mx-auto my-0.5 flex h-9 w-9 items-center justify-center rounded-lg text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-25 ${
                        selected
                          ? "bg-blue-600 text-white shadow-sm shadow-blue-600/30"
                          : today
                            ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
                            : day.inCurrentMonth
                              ? "text-slate-700 hover:bg-slate-100"
                              : "text-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      {day.day}
                    </button>
                  );
                })}
              </div>
            </section>

            <section
              className="border-t border-slate-100 bg-slate-50/60 p-4 sm:p-5 md:border-l md:border-t-0"
              aria-label="Thời gian"
            >
              <div className="mb-5 flex items-center gap-2">
                <Clock3 size={17} className="text-blue-600" />
                <h3 className="text-sm font-bold text-slate-800">Thời gian</h3>
              </div>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                <TimeSpinner
                  label="Giờ"
                  value={draft.getHours()}
                  options={HOURS}
                  onChange={(nextValue) => setTimePart("hour", nextValue)}
                  onAdjust={(delta) => adjustTimePart("hour", delta)}
                />
                <span className="mt-1 text-2xl font-black text-slate-300">:</span>
                <TimeSpinner
                  label="Phút"
                  value={draft.getMinutes()}
                  options={MINUTES}
                  onChange={(nextValue) => setTimePart("minute", nextValue)}
                  onAdjust={(delta) => adjustTimePart("minute", delta)}
                />
              </div>
              <div className="mt-6 rounded-xl border border-blue-100 bg-white px-3 py-3 text-center">
                <p className="text-xs text-slate-400">Đang chọn</p>
                <p className="mt-1 text-base font-black text-slate-900">
                  {formatDateTimeDisplay(toLocalDateTimeValue(draft))}
                </p>
              </div>
            </section>
          </div>

          <div className="grid grid-cols-[auto_1fr] items-center gap-2 border-t border-slate-100 bg-white px-4 py-4 sm:flex sm:justify-between sm:px-5">
            <button
              type="button"
              onClick={chooseToday}
              className="rounded-xl border border-blue-200 px-4 py-2.5 text-sm font-semibold text-blue-700 transition hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Hôm nay
            </button>
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-400"
                >
                  Hủy
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={apply}
                className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/25 transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                Áp dụng
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TimeSpinner({ label, value, options, onChange, onAdjust }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      <button
        type="button"
        aria-label={`Tăng ${label.toLowerCase()}`}
        onClick={() => onAdjust(1)}
        className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 transition hover:border-blue-200 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <ChevronUp size={16} />
      </button>
      <div className="relative w-full">
        <select
          aria-label={`Chọn ${label.toLowerCase()}`}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full appearance-none rounded-xl border border-slate-200 bg-white px-3 py-3 text-center text-xl font-black text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {String(option).padStart(2, "0")}
            </option>
          ))}
        </select>
        <ChevronDown
          size={14}
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400"
        />
      </div>
      <button
        type="button"
        aria-label={`Giảm ${label.toLowerCase()}`}
        onClick={() => onAdjust(-1)}
        className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 transition hover:border-blue-200 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <ChevronDown size={16} />
      </button>
    </div>
  );
}

export default DateTimePicker;
