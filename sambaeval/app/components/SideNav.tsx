"use client";
import { apiUrl } from "@/app/lib/api";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

interface NavItem {
  href: string;
  label: string;
  isActive: (pathname: string) => boolean;
}

const ITEMS: NavItem[] = [
  {
    href: "/",
    label: "Experiments",
    isActive: (p) => p === "/" || p.startsWith("/experiments"),
  },
  {
    href: "/datasets",
    label: "Datasets",
    isActive: (p) => p === "/datasets" || p.startsWith("/datasets/"),
  },
  {
    href: "/scorers",
    label: "Scorers",
    isActive: (p) => p === "/scorers" || p.startsWith("/scorers/"),
  },
  {
    href: "/providers",
    label: "Providers",
    isActive: (p) => p === "/providers" || p.startsWith("/providers/"),
  },
];

export default function SideNav() {
  const pathname = usePathname();
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Fetch app version on mount
  useEffect(() => {
    const fetchAppVersion = async () => {
      try {
        const response = await fetch(apiUrl("/api/app-version"));
        const data = await response.json();
        if (data.success) {
          setAppVersion(data.version);
        }
      } catch (error) {
        console.error("Failed to fetch app version:", error);
      }
    };

    fetchAppVersion();
  }, []);

  return (
    <nav className="flex flex-col h-full gap-1 px-3 py-4">
      {ITEMS.map((item) => {
        const active = item.isActive(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`px-3 py-2 rounded-md text-sm transition-colors ${
              active
                ? "bg-[var(--accent-soft)] text-[var(--accent)] font-semibold"
                : "text-[var(--foreground)] font-medium hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
            }`}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}

      {/* App version display */}
      {appVersion && (
        <div className="mt-auto mx-1 mb-1 rounded-md bg-[var(--accent-soft)] px-2 py-1.5 text-center">
          <span className="text-xs font-medium text-[var(--muted)]">
            SambaEval v{appVersion}
          </span>
        </div>
      )}
    </nav>
  );
}
