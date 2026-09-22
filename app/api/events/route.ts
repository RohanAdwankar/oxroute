const daemon = process.env.OXROUTE_DAEMON ?? "http://127.0.0.1:8787";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const upstream = await fetch(`${daemon}/api/events`, {
    cache: "no-store",
    headers: { accept: "text/event-stream" },
    signal: request.signal,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "x-accel-buffering": "no",
    },
  });
}
