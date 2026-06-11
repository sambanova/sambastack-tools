"use client";

import { useState } from "react";

export default function InfoTooltip({
  text,
  align = "center",
  widthClass = "w-80",
}: {
  text: string;
  align?: "center" | "left" | "right";
  widthClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const positionClass =
    align === "left"
      ? "left-0"
      : align === "right"
        ? "right-0"
        : "left-1/2 -translate-x-1/2";
  return (
    <span className="relative inline-block ml-1 align-middle">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        aria-label="Help"
        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-[var(--panel-2)] border border-[var(--border)] text-[10px] text-[var(--muted)] hover:bg-[var(--accent)] hover:text-white hover:border-[var(--accent)] cursor-help leading-none"
      >
        ?
      </button>
      {open && (
        <span className={`absolute ${positionClass} top-full mt-2 ${widthClass} bg-[var(--panel-2)] border border-[var(--border)] rounded-md p-3 text-xs text-[var(--foreground)] shadow-xl z-30 normal-case font-normal leading-relaxed whitespace-pre-line`}>
          {text}
        </span>
      )}
    </span>
  );
}
