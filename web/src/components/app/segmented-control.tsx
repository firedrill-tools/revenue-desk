import { useId } from "react";
import { cn } from "@/lib/utils";

export type SegmentOption<T extends string> = { readonly value: T; readonly label: string };

/**
 * Native radio buttons drawn as a segmented control, so arrow keys, focus and
 * screen readers behave like any radio group.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  toneFor,
}: {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  /** Optional emphasis for the selected option (e.g. danger for "auto" on money). */
  toneFor?: (value: T) => "default" | "danger";
}) {
  const name = useId();
  return (
    <fieldset
      disabled={disabled}
      className={cn(
        "inline-flex h-8 shrink-0 items-center self-start rounded-md border bg-surface-subtle p-0.5 sm:self-auto pointer-coarse:h-11",
        disabled && "opacity-60",
      )}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((option) => {
        const selected = option.value === value;
        const danger = selected && toneFor?.(option.value) === "danger";
        return (
          <label
            key={option.value}
            className={cn(
              "relative flex h-full min-w-14 cursor-pointer items-center justify-center rounded-[5px] px-3 font-medium text-body-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-not-allowed",
              selected
                ? "bg-background text-foreground ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
              danger && "text-danger",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </fieldset>
  );
}
