import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  const version = await readFile(join(process.cwd(), process.env.OXROUTE_DIST ?? ".next", "BUILD_ID"), "utf8");
  return Response.json({ version: version.trim() }, { headers: { "cache-control": "no-store" } });
}
