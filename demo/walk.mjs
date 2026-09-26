// The walkthrough itself: one pass through oxroute, filmed.
//
// It is driven through the interface rather than the API wherever the
// interface is the point, because what this shows is what a person does.
// demo/run.sh sets the three variables below and cleans up after it.
import { chromium } from "playwright";

const URL = process.env.OXROUTE_DEMO_URL ?? "http://127.0.0.1:3100";
const API = process.env.OXROUTE_DEMO_API ?? "http://127.0.0.1:8799";
const OUT = process.env.OXROUTE_DEMO_OUT ?? "demo/out";

/// The screen at 175% zoom, which is where this interface is read.
const SCREEN = { width: 1280, height: 800 };

const api = (path, body) =>
  fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then((answer) => answer.json());

let beat = 0;
const shot = async (page, name) => {
  beat += 1;
  await page.screenshot({ path: `${OUT}/${String(beat).padStart(2, "0")}-${name}.png` });
};

/// Wait for something to become true, rather than for a length of time: an
/// agent answers when it answers.
const until = async (what, seconds = 180) => {
  for (let waited = 0; waited < seconds * 2; waited += 1) {
    if (await what()) return true;
    await new Promise((wake) => setTimeout(wake, 500));
  }
  throw new Error("waited long enough");
};

/// A demo that dies halfway is worth looking at, so it leaves a picture of
/// wherever it got to.
process.on("unhandledRejection", async (reason) => {
  await page?.screenshot({ path: `${OUT}/99-stopped-here.png` }).catch(() => {});
  console.error(reason);
  process.exit(1);
});

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: SCREEN,
  deviceScaleFactor: 2,
  recordVideo: { dir: OUT, size: SCREEN },
});
let page;
page = await context.newPage();
await page.goto(URL);

// 1. Something arrives. With no Slack wired up this is the same POST a
//    source would make.
await api("/api/signal", {
  source: "demo",
  conversation: "C1",
  user: "demo",
  text: "the shed needs painting -- what colour did we agree on?",
});
await until(async () => (await page.locator("text=the shed needs painting").count()) > 0);
await shot(page, "inbox");

// 2. You decide where it goes, and a session starts on it.
await page.locator("text=the shed needs painting").first().click();
await page.waitForTimeout(500);
await shot(page, "routing");
await page.locator('[aria-label="start a new agent"]').click();
await until(async () => (await api("/api/state")).agents.length > 0);
await shot(page, "session");

// 3. The answer comes back. Opening the card is where you read it.
const name = (await api("/api/state")).agents[0].name;
await page.locator(`text=${name}`).first().click();
await until(async () => (await page.locator("[data-composer]").count()) > 0);
await until(async () => (await api("/api/state")).agents[0].status !== "working", 300);
await page.waitForTimeout(800);
await shot(page, "answer");

// 4. Not everything is worth saying now. Tab files it instead, and the
//    list opens on what was just filed.
const composer = page.locator("[data-composer]");
await composer.click();
await composer.type("check the paint colour against the tin in the garage");
await composer.press("Tab");
await until(async () => (await page.locator("text=check the paint colour").count()) > 0);
await shot(page, "filed");

// 5. The agent says it is done; a person decides whether it is. Saying no
//    puts the task above the composer and you answer it there.
const tasks = await api("/api/tasks");
const filed = tasks.find((task) => task.text.startsWith("check the paint colour"));
await fetch(`${API}/api/tasks/${filed.id}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...filed,
    agentId: filed.agentId,
    status: "done",
    note: "checked it -- the tin says dove grey",
  }),
});
await until(async () => (await page.getByRole("button", { name: "Not yet" }).count()) > 0);
await shot(page, "done");
await page.getByRole("button", { name: "Not yet" }).first().click();
await page.waitForTimeout(400);
await shot(page, "not-yet");
await page.keyboard.type("the garage tin is last year's -- check the invoice");
await shot(page, "correction");
await page.keyboard.press("Escape");

// 6. Saying something by drawing it: the change to the picture is the
//    message, and the file on disk changes with it.
await page.locator('[aria-label="Attach images"] ~ button, [aria-label="Attach images options"]').first().click();
await page.waitForTimeout(300);
await page.getByRole("menuitem", { name: /Diagram/ }).click();
// The picture is drawn by oxdraw on the daemon side, so wait for the
// diagram itself rather than for the pane that will hold it.
await until(async () => (await page.locator("text=Changes").count()) > 0, 60);
await page.waitForTimeout(800);
await shot(page, "diagram");

// Drawing a box is the message: the file changes and the agent is told
// what changed and why.
await page.locator('[aria-label="new box label"]').fill("the invoice");
await page.locator('[aria-label="add the box"]').click();
await until(async () => (await page.locator("text=the invoice").count()) > 0, 60);
await shot(page, "drawn");

// Sending it writes the file and tells the agent what changed.
await page.locator("[data-composer]").fill("this is where the colour is written down");
await page.getByRole("button", { name: /Send the change/ }).first().click();
await until(async () => (await api("/api/state")).agents[0].status === "working", 60);
await page.waitForTimeout(1500);
await shot(page, "sent");

// 7. Branching the work, and the two places a branch can land.
await page.locator('[aria-label$="options"]').first().click();
await page.waitForTimeout(300);
await shot(page, "fork");
await page.keyboard.press("Escape");

// 8. The interface has two questions in it, and this is both of them.
await page.locator('[title="Settings"]').click();
await page.waitForTimeout(300);
await shot(page, "settings");
await page.getByRole("button", { name: /Dark/ }).click();
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await shot(page, "dark");
await page.locator('[title="Settings"]').click();
await page.getByRole("button", { name: /Light/ }).click();
await page.keyboard.press("Escape");

// 9. Everything said is searchable, including sessions that were never
//    oxroute's to begin with.
await page.getByPlaceholder("Search sessions").fill("shed");
await page.waitForTimeout(1200);
await shot(page, "search");

await context.close();
await browser.close();
