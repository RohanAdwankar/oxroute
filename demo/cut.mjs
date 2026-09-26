// Take the waiting out of the film.
//
// Most of a demo's running time is an agent thinking, which is honest but
// not watchable. walk.mjs writes down the spans where nothing happens but
// waiting; this drops them and leaves the beats.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";

const OUT = process.env.OXROUTE_DEMO_OUT ?? "demo/out";
const raw = readdirSync(OUT).find((name) => name.endsWith(".webm"));
if (!raw) {
  console.error("no recording to cut");
  process.exit(1);
}
const cuts = JSON.parse(readFileSync(`${OUT}/cuts.json`, "utf8"));

/// Half a second of each wait is kept, so a cut reads as a pause rather
/// than a jump.
const KEEP = 0.3;
const dropped = cuts
  .map(([from, to]) => [from + KEEP, to - KEEP])
  .filter(([from, to]) => to - from > 1);

const keep = dropped.length
  ? `not(${dropped.map(([from, to]) => `between(t,${from.toFixed(2)},${to.toFixed(2)})`).join("+")})`
  : "1";

execFileSync(
  "ffmpeg",
  [
    "-loglevel", "error",
    "-i", `${OUT}/${raw}`,
    "-vf", `select='${keep}',setpts=N/FRAME_RATE/TB`,
    "-an",
    "-y", `${OUT}/demo.mp4`,
  ],
  { stdio: "inherit" },
);
rmSync(`${OUT}/${raw}`);
rmSync(`${OUT}/cuts.json`);

const seconds = Number(
  execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    `${OUT}/demo.mp4`,
  ]).toString(),
);
console.log(`${OUT}/demo.mp4 — ${Math.round(seconds)}s`);
