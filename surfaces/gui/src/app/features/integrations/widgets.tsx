// Small shared widgets for the 连接器 tab: the brand monogram chip, status dot,
// and the chip-list editor row (Gmail filters, HubSpot hidden fields).

import { useState } from "react";
import type { Connector } from "../../lib/api/types";
import { brandStyles, monogram, TONE_DOT, type StatusTone } from "./integrationLogic";
import { LABEL, ROW, XBTN } from "./ui";

/** Tinted monogram chip — the brand_color from the server, no logo dependency. */
export function ConnectorBadge({ c, size = 34 }: { c: Connector; size?: number }) {
  const styles = brandStyles(c.brand_color);
  return (
    <span
      className="grid shrink-0 place-items-center rounded-lg font-bold"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        borderRadius: Math.max(6, Math.round(size * 0.24)),
        ...styles.badge,
      }}
      aria-hidden="true"
    >
      {monogram(c)}
    </span>
  );
}

export function Dot({ tone }: { tone: StatusTone }) {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />;
}

/** Label + chip list + inline add input. Save fires with the full next list. */
export function ChipEditorRow({
  label,
  values,
  placeholder,
  mono = false,
  onSave,
}: {
  label: string;
  values: string[];
  placeholder: string;
  mono?: boolean;
  onSave: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    setDraft("");
    if (!values.includes(v)) onSave([...values, v]);
  };
  return (
    <div className={ROW}>
      <span className={LABEL}>{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className={`inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-[12px] shadow-[inset_0_0_0_0.5px_var(--line-strong)] ${mono ? "font-mono" : ""}`}
          >
            {v}
            <button
              type="button"
              className={XBTN}
              title="移除"
              onClick={() => onSave(values.filter((x) => x !== v))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="min-w-[140px] flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
          placeholder={placeholder}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          onBlur={() => draft.trim() && add()}
        />
      </span>
    </div>
  );
}
