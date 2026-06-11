import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import "./globals.css";
import SideNav from "./components/SideNav";

export const metadata: Metadata = {
  title: "SambaEval",
  description: "Local LLM evaluation workbench",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="h-screen flex flex-col overflow-hidden">
        <header className="relative shrink-0 border-b border-[var(--border)] bg-[var(--panel)]">
          <div className="px-6 py-3 flex items-center">
            <Link href="/" aria-label="SambaEval home" className="flex items-center">
              <Image
                src="/sambanova-logo.png"
                alt="SambaNova"
                width={140}
                height={31}
                priority
                className="h-7 w-auto"
              />
            </Link>
            <span className="absolute left-1/2 -translate-x-1/2 text-2xl font-semibold tracking-tight bg-gradient-to-r from-[#A2297D] to-[#4E226B] bg-clip-text text-transparent">
              SambaEval
            </span>
          </div>
        </header>
        <div className="flex flex-1 min-h-0">
          <aside className="w-56 shrink-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--panel)]">
            <SideNav />
          </aside>
          <main className="flex-1 px-6 py-8 min-w-0 overflow-y-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}