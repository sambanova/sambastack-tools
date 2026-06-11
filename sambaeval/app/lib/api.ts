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
