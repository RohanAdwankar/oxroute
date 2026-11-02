export type Review = {
  id: string; agentId: string; title: string; description: string; status: "pending" | "approved" | "stale"; staleNotified?: boolean;
  full: boolean;
  snapshot: { repository: string; remote: string; remoteUrl: string; branch: string;
    baseRef: string; baseCommit: string; headCommit: string; reviewBaseCommit?: string; files: { path: string; patch: string; image?: { before: boolean; after: boolean } }[] };
};

const ready = new Map<string, Review>();
const pending = new Map<string, Promise<Review>>();
const images = new Map<string, Promise<Blob>>();
export const reviewEndpoint = (agent: string, review: string) =>
  `/api/agents/${encodeURIComponent(agent)}/reviews/${encodeURIComponent(review)}`;
export const cachedReview = (endpoint: string) => ready.get(endpoint);

type StoredResponse = { body: ArrayBuffer; headers: [string, string][]; status: number };
let disk: Promise<IDBDatabase> | undefined;
function stored<T>(key: string, value?: StoredResponse): Promise<T> {
  disk ??= new Promise((resolve, reject) => {
    const open = indexedDB.open("oxroute.reviews.v1", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("responses");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return disk.then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction("responses", value ? "readwrite" : "readonly");
    const store = transaction.objectStore("responses");
    const request = value ? store.put(value, key) : store.get(key);
    transaction.oncomplete = () => resolve(request.result as T);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

async function storedResponse(url: string, refresh: boolean, priority: RequestPriority): Promise<Response> {
  const saved = !refresh && await stored<StoredResponse | undefined>(url).catch(() => undefined);
  if (saved) return new Response(saved.body, { headers: saved.headers, status: saved.status });
  const response = await fetch(url, { cache: refresh ? "no-store" : "default", priority, headers: priority === "low" ? { "x-oxroute-prefetch": "1" } : {} });
  if (response.ok) await stored(url, { body: await response.clone().arrayBuffer(), headers: [...response.headers], status: response.status }).catch(() => {});
  return response;
}

export function loadReviewImage(url: string, priority: RequestPriority = "high"): Promise<Blob> {
  const running = images.get(url);
  if (running) return running;
  const request = storedResponse(url, false, priority).then(response => {
    if (!response.ok) throw new Error("Could not load review image");
    return response.blob();
  }).finally(() => images.delete(url));
  images.set(url, request);
  return request;
}

function requestReview(endpoint: string, refresh: boolean, priority: RequestPriority): Promise<Review> {
  const running = pending.get(endpoint);
  if (running) return running;
  const cached = ready.get(endpoint);
  if (cached && !refresh) return Promise.resolve(cached);
  const request = storedResponse(endpoint, refresh, priority).then(async response => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load review");
    body.snapshot = ready.get(endpoint)?.snapshot ?? body.snapshot;
    ready.delete(endpoint);
    ready.set(endpoint, body);
    if (ready.size > 8) ready.delete(ready.keys().next().value!);
    return body as Review;
  }).finally(() => pending.delete(endpoint));
  pending.set(endpoint, request);
  return request;
}

export const loadReview = (endpoint: string, refresh = false) => requestReview(endpoint, refresh, "high");

// Leave connection capacity for a clicked review, live events and histories.
const warming = new Set<string>();
const recent = new Set<string>();
let draining = false;
export function preloadReview(endpoint: string, created = false) {
  if (ready.has(endpoint) || pending.has(endpoint)) return;
  if (created) warming.delete(endpoint);
  (created ? recent : warming).add(endpoint);
  if (draining) return;
  draining = true;
  void (async () => {
    try {
      while (recent.size || warming.size) {
        const queue = recent.size ? recent : warming;
        const next = queue.values().next().value!;
        queue.delete(next);
        try {
          const review = await requestReview(next, false, "low");
          if (review.snapshot.reviewBaseCommit && !next.includes("?full=true")) preloadReview(`${next}?full=true`);
          for (const file of review.snapshot.files) for (const side of ["before", "after"] as const) {
            if (file.image?.[side]) await loadReviewImage(`${next.split("?")[0]}/image?${new URLSearchParams({ path: file.path, side, ...(review.full ? { full: "true" } : {}) })}`, "low").catch(() => {});
          }
        }
        catch { /* A foreground open reports errors; warming stays quiet. */ }
      }
    } finally { draining = false; }
  })();
}
