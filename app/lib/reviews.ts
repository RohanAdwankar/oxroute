export type Review = {
  id: string; title: string; description: string; status: "pending" | "approved" | "stale";
  snapshot: { repository: string; remote: string; remoteUrl: string; branch: string;
    baseRef: string; baseCommit: string; headCommit: string; files: { path: string; patch: string }[] };
};

const ready = new Map<string, Review>();
const pending = new Map<string, Promise<Review>>();
export const reviewEndpoint = (agent: string, review: string) =>
  `/api/agents/${encodeURIComponent(agent)}/reviews/${encodeURIComponent(review)}`;
export const cachedReview = (endpoint: string) => ready.get(endpoint);

export function loadReview(endpoint: string, refresh = false): Promise<Review> {
  const running = pending.get(endpoint);
  if (running) return running;
  const cached = ready.get(endpoint);
  if (cached && !refresh) return Promise.resolve(cached);
  const request = fetch(endpoint, { cache: "no-store" }).then(async response => {
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
