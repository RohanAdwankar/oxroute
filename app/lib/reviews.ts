export type Review = {
  id: string; agentId: string; title: string; description: string; status: "pending" | "approved" | "stale";
  full: boolean;
  snapshot: { repository: string; remote: string; remoteUrl: string; branch: string;
    baseRef: string; baseCommit: string; headCommit: string; reviewBaseCommit?: string; files: { path: string; patch: string; image?: { before: boolean; after: boolean } }[] };
};

const ready = new Map<string, Review>();
const pending = new Map<string, Promise<Review>>();
export const reviewEndpoint = (agent: string, review: string) =>
  `/api/agents/${encodeURIComponent(agent)}/reviews/${encodeURIComponent(review)}`;
export const cachedReview = (endpoint: string) => ready.get(endpoint);

function requestReview(endpoint: string, refresh: boolean, priority: RequestPriority): Promise<Review> {
  const running = pending.get(endpoint);
  if (running) return running;
  const cached = ready.get(endpoint);
  if (cached && !refresh) return Promise.resolve(cached);
  const request = fetch(endpoint, { cache: "no-store", priority }).then(async response => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load review");
    ready.delete(endpoint);
    ready.set(endpoint, body);
    if (ready.size > 8) ready.delete(ready.keys().next().value!);
    return body as Review;
  }).catch(error => { ready.delete(endpoint); throw error; })
    .finally(() => pending.delete(endpoint));
  pending.set(endpoint, request);
  return request;
}

export const loadReview = (endpoint: string, refresh = false) => requestReview(endpoint, refresh, "high");

// Leave connection capacity for a clicked review, live events and histories.
const warming = new Set<string>();
let draining = false;
export function preloadReview(endpoint: string) {
  if (ready.has(endpoint) || pending.has(endpoint)) return;
  warming.add(endpoint);
  if (draining) return;
  draining = true;
  void (async () => {
    try {
      while (warming.size) {
        const next = warming.values().next().value!;
        warming.delete(next);
        try { await requestReview(next, false, "low"); }
        catch { /* A foreground open reports errors; warming stays quiet. */ }
      }
    } finally { draining = false; }
  })();
}
