"use client";

import Image from "next/image";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { API_BASE, apiFetch, apiUrl } from "@/app/lib/api";
import type { AuthUser } from "@/app/lib/types";

// The multi-tenant backend requires an authenticated session; AuthGate is the
// client boundary that establishes it. It calls GET /api/auth/me on mount and
// only renders the app shell once a user comes back — otherwise it shows a
// centered login screen. The resolved user is published through context so the
// header's user chip (and anything else) can read it without refetching.

interface AuthContextValue {
  user: AuthUser;
  authBackend: string;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Read the current user inside AuthGate's children. Safe to call anywhere under
// the gate, since children only mount once a user exists.
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthGate");
  }
  return ctx;
}

// Dev-mode probe: the `dev` auth backend only ever runs against a local
// backend (it returns a fixed dev user), so a localhost base URL is the signal
// to offer the "Continue (dev)" shortcut on the login screen.
const IS_LOCAL_BACKEND =
  API_BASE.includes("localhost") || API_BASE.includes("127.0.0.1");

interface MeResponse {
  user: AuthUser;
  auth_backend: string;
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authBackend, setAuthBackend] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [devLoggingIn, setDevLoggingIn] = useState(false);

  const checkMe = useCallback(async (): Promise<boolean> => {
    try {
      const res = await apiFetch("/api/auth/me");
      if (!res.ok) {
        setUser(null);
        return false;
      }
      const data: MeResponse = await res.json();
      setUser(data.user ?? null);
      setAuthBackend(data.auth_backend ?? "");
      return true;
    } catch {
      setUser(null);
      return false;
    }
  }, []);

  useEffect(() => {
    (async () => {
      await checkMe();
      setLoading(false);
    })();
  }, [checkMe]);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // best-effort: clear the client state regardless.
    }
    setUser(null);
  }, []);

  const signInGoogle = () => {
    window.location.href = apiUrl("/api/auth/google/login");
  };

  const continueDev = async () => {
    setDevLoggingIn(true);
    try {
      await apiFetch("/api/auth/dev-login", { method: "POST" });
      await checkMe();
    } catch {
      // best-effort: leave the login screen up if it failed.
    } finally {
      setDevLoggingIn(false);
    }
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <span
          className="inline-block h-8 w-8 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] animate-spin"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-sm bg-[var(--panel)] border border-[var(--border)] rounded-xl p-8 text-center">
          <div className="flex justify-center mb-4">
            <Image
              src="/sambanova-logo.png"
              alt="SambaNova"
              width={160}
              height={35}
              priority
              className="h-8 w-auto"
            />
          </div>
          <div className="text-2xl font-semibold tracking-tight bg-gradient-to-r from-[#A2297D] to-[#4E226B] bg-clip-text text-transparent mb-2">
            SambaEval
          </div>
          <p className="text-sm text-[var(--muted)] mb-6">
            Sign in to access your evaluation workbench.
          </p>
          <button
            onClick={signInGoogle}
            className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md font-medium"
          >
            Sign in with Google
          </button>
          {IS_LOCAL_BACKEND && (
            <button
              onClick={continueDev}
              disabled={devLoggingIn}
              className="w-full mt-3 border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)] text-[var(--muted)] px-4 py-2 rounded-md font-medium disabled:opacity-50"
            >
              {devLoggingIn ? "Signing in…" : "Continue (dev)"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ user, authBackend, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// Small header chip showing the signed-in user's name/email plus a Logout
// action. Lives inside AuthGate's children so it can read the auth context.
export function UserChip() {
  const { user, logout } = useAuth();
  return (
    <div className="flex items-center gap-3">
      <div className="text-right leading-tight hidden sm:block">
        <div className="text-sm font-medium">{user.name || user.email}</div>
        <div className="text-xs text-[var(--muted)]">{user.email}</div>
      </div>
      <button
        onClick={logout}
        className="text-xs border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)] text-[var(--muted)] px-3 py-1.5 rounded-md"
      >
        Logout
      </button>
    </div>
  );
}
