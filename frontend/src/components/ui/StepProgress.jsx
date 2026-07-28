import { Check } from "lucide-react";

export default function StepProgress({ steps, current }) {
  return (
    <nav className="mx-auto mb-8 max-w-3xl sm:mb-10" aria-label="Các bước chuyển đổi">
      <ol
        aria-label="Tiến trình chuyển đổi"
        className="flex items-center justify-between gap-1 overflow-x-auto pb-1 sm:gap-0"
      >
        {steps.map((label, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li
              key={label}
              aria-current={active ? "step" : undefined}
              className="flex shrink-0 items-center gap-2 sm:flex-1 sm:justify-center"
            >
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-all duration-300 ${
                  done
                    ? "bg-emerald-500 text-white shadow-sm"
                    : active
                      ? "bg-primary-600 text-white ring-4 ring-primary-100"
                      : "bg-gray-100 text-gray-400"
                }`}
              >
                {done ? <Check size={14} /> : index + 1}
              </span>
              <span
                className={`sr-only text-xs font-medium transition-colors sm:not-sr-only sm:block ${
                  active ? "text-gray-900" : done ? "text-emerald-700" : "text-gray-400"
                }`}
              >
                {label}
              </span>
              {index < steps.length - 1 && (
                <span
                  className={`hidden h-px w-8 mx-2 transition-colors sm:block lg:w-16 ${
                    done ? "bg-emerald-300" : "bg-gray-200"
                  }`}
                  aria-hidden
                />
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-center text-sm font-bold text-slate-700 sm:hidden">
        Bước {current + 1}/{steps.length} · {steps[current]}
      </p>
    </nav>
  );
}
