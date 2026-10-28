/** Keep transport errors until the daemon can receive them, including across reloads. */
const key = "oxroute.clientFailures";
type Failure = { id: string; at: number; path: string; method: string; status: number; agent: string; requestId: string; message: string; version: string; online: boolean; browser: string };
let flushing = false;
const read = (): Failure[] => JSON.parse(localStorage.getItem(key) ?? "[]");

export async function flushClientFailures() {
  if (flushing) return;
  flushing = true;
  try {
    for (const failure of read()) {
      const response = await fetch("/api/client-failures", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(failure), signal: AbortSignal.timeout(5000) });
      if (!response.ok) break;
      localStorage.setItem(key, JSON.stringify(read().filter(item => item.id !== failure.id)));
    }
  } catch { /* Offline reports remain queued for the next connection. */ }
  finally { flushing = false; }
}

export function recordClientFailure(path: string, init: RequestInit | undefined, status: number, error: unknown) {
  try {
    const payload = init?.body;
    const body = payload instanceof FormData ? Object.fromEntries(["agent", "requestId"].map(field => [field, payload.get(field)])) : typeof payload === "string" ? JSON.parse(payload) : {};
    const failure: Failure = { id: crypto.randomUUID(), at: Date.now()/1000, path: path.split("?")[0], method: init?.method ?? "GET", status, agent: String(body.agent ?? ""), requestId: String(body.requestId ?? ""), message: String(error instanceof Error ? error.message : error).slice(0, 2000), version: process.env.NEXT_PUBLIC_WEB_VERSION ?? "", online: navigator.onLine, browser: navigator.userAgent };
    localStorage.setItem(key, JSON.stringify([...read(), failure].slice(-100)));
    void flushClientFailures();
  } catch { /* Diagnostics must not change request or draft handling. */ }
}

export function captureClientFailures() {
  void flushClientFailures();
  const retry = () => { if (!document.hidden) void flushClientFailures(); };
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", retry);
  const timer = window.setInterval(retry, 30000);
  return () => { clearInterval(timer); window.removeEventListener("online", retry); document.removeEventListener("visibilitychange", retry); };
}
