"use client";

import { useEffect, useRef, useState } from "react";

// A combobox for the model name: a free-text input paired with a dropdown that
// always lists every available model for the provider. Unlike a native
// <datalist> (which prefix/substring-filters its options against whatever is
// typed and offers no way to opt out), opening this list always shows the full
// set — so a user can browse all models even after typing into the field.
export default function ModelNameCombobox({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close the list on any click outside the combobox.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const hasOptions = options.length > 0;
  // A non-empty typed value that isn't one of the known models is a valid
  // custom name — surface it at the top of the list so it's clear the field
  // isn't restricted to the options.
  const isCustom = value.trim() !== "" && !options.includes(value);

  return (
    <div ref={containerRef} className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => hasOptions && setOpen(true)}
        placeholder={placeholder}
        spellCheck={false}
        // Inline padding: the unlayered global `input { padding: 6px 10px }`
        // rule outranks Tailwind padding utilities, so a class wouldn't stick.
        // Leaves room for the chevron toggle.
        style={hasOptions ? { paddingRight: "1.75rem" } : undefined}
      />
      {hasOptions && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Hide model list" : "Show model list"}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--accent)] text-xs"
        >
          {open ? "▴" : "▾"}
        </button>
      )}
      {open && hasOptions && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-[var(--panel-2)] border border-[var(--border)] rounded-md shadow-xl z-20 max-h-64 overflow-y-auto">
          {isCustom && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="block w-full text-left px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-[var(--panel)] whitespace-nowrap border-b border-[var(--border)]"
            >
              Use “{value}” (custom)
            </button>
          )}
          {options.map((name) => (
            <button
              type="button"
              key={name}
              onClick={() => {
                onChange(name);
                setOpen(false);
              }}
              className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--panel)] whitespace-nowrap ${
                name === value ? "text-[var(--accent)] font-medium" : ""
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
