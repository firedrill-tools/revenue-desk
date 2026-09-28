import { XIcon } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import { Input } from "@/components/ui/input";

/**
 * Edits a short list of strings (email domains, Slack channels) as removable
 * chips plus an input; Enter, comma or blur adds. `normalize` returns the
 * stored form or an error message.
 */
export function ListEditor({
  values,
  onChange,
  normalize,
  placeholder,
  label,
  emptyText,
}: {
  values: readonly string[];
  onChange: (values: string[]) => void;
  normalize: (raw: string) => { value: string } | { error: string };
  placeholder: string;
  label: string;
  emptyText: string;
}) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const errorId = useId();

  const commit = () => {
    const raw = draft.trim();
    if (raw === "") return;
    const result = normalize(raw);
    if ("error" in result) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    setDraft("");
    if (!values.includes(result.value)) onChange([...values, result.value]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="space-y-2">
      {values.length > 0 ? (
        <ul aria-label={label} className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li
              key={value}
              className="inline-flex h-7 items-center gap-1 rounded-md border bg-surface-subtle pr-1 pl-2 font-mono text-meta"
            >
              {value}
              <button
                type="button"
                onClick={() => onChange(values.filter((item) => item !== value))}
                aria-label={`Remove ${value}`}
                className="rd-hit relative inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body-sm text-muted-foreground">{emptyText}</p>
      )}
      <Input
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setProblem(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={placeholder}
        aria-label={`Add to ${label}`}
        aria-invalid={problem !== null || undefined}
        aria-describedby={problem ? errorId : undefined}
        className="max-w-md md:text-body-sm"
      />
      {problem ? (
        <p id={errorId} className="text-meta text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
