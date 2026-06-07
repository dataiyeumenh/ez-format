import { Check } from "lucide-react";

export default function StepProgress({ steps, current }) {
  return (
    <ol className="flex flex-wrap items-center justify-center gap-2 sm:gap-0 sm:justify-between max-w-2xl mx-auto mb-10">
      {steps.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={label}
            className="flex items-center gap-2 sm:flex-1 sm:justify-center"
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
              className={`hidden sm:block text-xs font-medium transition-colors ${
                active ? "text-gray-900" : done ? "text-emerald-700" : "text-gray-400"
              }`}
            >
              {label}
            </span>
            {index < steps.length - 1 && (
              <span
                className={`hidden sm:block h-px w-8 lg:w-16 mx-2 transition-colors ${
                  done ? "bg-emerald-300" : "bg-gray-200"
                }`}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
