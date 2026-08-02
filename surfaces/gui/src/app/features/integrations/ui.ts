// Shared style grammar for the 集成 page: macOS System-Settings grouped inset lists —
// quiet 44px rows, hairline separators, pill buttons, small status tags. Mirrors
// ui-mocks/connectors-redesign.html and the Agents page conventions.

/** Grouped inset list container; children separate with `divide-y divide-line`. */
export const GRP =
  "overflow-hidden rounded-xl bg-panel shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]";

/** Sentence-case section header above a group. */
export const GRP_H = "mb-1.5 mt-6 px-1 text-[12px] font-semibold text-muted";

/** Quiet footnote under a group. */
export const FOOT = "mt-1.5 px-1 text-[12px] text-faint";

/** One list row: 44px minimum, comfortable gaps. */
export const ROW = "flex min-h-[44px] items-center gap-3 px-4 py-2.5";

/** The muted label column on the left of a settings row. */
export const LABEL = "w-24 shrink-0 text-[12.5px] text-muted";

export const PILL_ACCENT =
  "shrink-0 rounded-full bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-50";
export const PILL_QUIET =
  "shrink-0 rounded-full bg-solid px-3 py-1.5 text-[12.5px] font-medium text-accent hover:brightness-95 disabled:opacity-50";
export const PILL_LINE =
  "shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium text-ink shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-paper disabled:opacity-50";

export const TAG = "shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-semibold";
export const TAG_ACCENT = `${TAG} bg-accentSoft text-accent`;
export const TAG_WARN = `${TAG} bg-warnSoft text-warnInk`;
export const TAG_QUIET = `${TAG} bg-solid text-muted`;

/** Small × affordance (danger on hover). */
export const XBTN = "shrink-0 leading-none text-faint hover:text-danger";

/** Text input inside a form/drawer. */
export const INPUT =
  "w-full rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent";
