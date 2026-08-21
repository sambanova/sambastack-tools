// Base URL of the SambaEval Python backend (FastAPI). The UI (Next dev server,
// port 3001) and the API (uvicorn, port 8000) run as two separate processes,
// so the browser talks to the API cross-origin. Override with
// NEXT_PUBLIC_API_BASE_URL if you run the backend elsewhere.
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

// Prefix an `/api/...` path with the backend base URL.
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

// Fetch a backend `/api/...` path with cookies attached. The app now requires
// an authenticated session (a backend-issued cookie), and because the UI and
// API run cross-origin, every request must opt in to sending cookies with
// `credentials: "include"`. Use this in place of `fetch(apiUrl(...))` for every
// API call so the session travels with it.
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), { ...init, credentials: "include" });
}
