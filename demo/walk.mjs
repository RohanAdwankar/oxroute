// The walkthrough itself: one pass through oxroute, filmed and captioned.
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

/// Long enough to read the caption before the next thing happens. A film
/// nobody can follow is a file, not a demo.
const READ = 4200;

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
const until = async (what, seconds = 300) => {
  for (let waited = 0; waited < seconds * 2; waited += 1) {
    if (await what()) return true;
    await new Promise((wake) => setTimeout(wake, 500));
  }
  // A demo that gives up is worth a picture of where it stopped.
  await page?.screenshot({ path: `${OUT}/99-stopped-here.png` }).catch(() => {});
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

/// What is happening, in words, over the picture. Without this the film is
/// a screen recording of someone else's afternoon.
const caption = async (text, hold = READ) => {
  await page.evaluate((words) => {
    let banner = document.getElementById("demo-caption");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "demo-caption";
      banner.style.cssText = [
        "position:fixed",
        "left:0",
        "right:0",
        "bottom:0",
        "z-index:2147483647",
        "background:rgba(20,17,14,0.92)",
        "color:#f7f4ef",
        "font:500 22px/1.4 ui-sans-serif,system-ui,sans-serif",
        "padding:18px 28px",
        "letter-spacing:0.1px",
        "pointer-events:none",
      ].join(";");
      document.body.appendChild(banner);
    }
    banner.textContent = words;
    banner.style.display = words ? "block" : "none";
  }, text);
  if (hold) await page.waitForTimeout(hold);
};

/// A card between chapters, so the film has somewhere to breathe.
const card = async (title, line, hold = 3600) => {
  await page.evaluate(
    ({ title, line }) => {
      let cover = document.getElementById("demo-card");
      if (!cover) {
        cover = document.createElement("div");
        cover.id = "demo-card";
        cover.style.cssText = [
          "position:fixed",
          "inset:0",
          "z-index:2147483646",
          "background:#141110",
          "color:#f7f4ef",
          "display:flex",
          "flex-direction:column",
          "align-items:center",
          "justify-content:center",
          "gap:14px",
          "font-family:ui-sans-serif,system-ui,sans-serif",
          "text-align:center",
        ].join(";");
        cover.innerHTML =
          '<div id="demo-card-title" style="font-size:44px;font-weight:600"></div>' +
          '<div id="demo-card-line" style="font-size:22px;color:#b0a598;max-width:44ch"></div>';
        document.body.appendChild(cover);
      }
      cover.style.display = title ? "flex" : "none";
      if (title) {
        cover.querySelector("#demo-card-title").textContent = title;
        cover.querySelector("#demo-card-line").textContent = line ?? "";
      }
    },
    { title, line },
  );
  if (hold) await page.waitForTimeout(hold);
};

// Ask first, so the film shows the decision being made rather than the
// machine making it. The other mode gets its own beat at the end.
await api("/api/mode", { mode: "ask" });
await page.goto(URL);
await page.waitForTimeout(800);

await card("oxroute", "Work arrives. You decide who does it. You watch it get done.");
await card("");

// 1. Something arrives. With no Slack wired up this is the same POST a
//    source would make.
await caption("A request arrives — from Slack, or anywhere that can post to oxroute.", 0);
await api("/api/signal", {
  source: "demo",
  conversation: "C1",
  user: "ops",
  text: "the health endpoint returns 200 with an empty body. Make it report the version and the commit.",
});
// A fresh browser has no memory of the columns, and the inbox starts
// folded away; the film is about what arrives in it.
if ((await page.locator('[aria-label="Show or hide the inbox"]').getAttribute("aria-pressed")) !== "true") {
  await page.locator('[aria-label="Show or hide the inbox"]').click();
}
await until(async () => (await page.getByText("empty body").count()) > 0, 30);
await caption("A request arrives — from Slack, or anywhere that can post to oxroute.");
await shot(page, "inbox");

// 2. You decide where it goes, and a session starts on it.
await page.getByText("empty body").first().click();
await caption("Nothing is routed behind your back. You pick who gets it.");
await shot(page, "routing");
await page.locator('[aria-label="start a new agent"]').click();
await caption("A new agent starts on it, in the repository you pointed oxroute at.");
await until(async () => (await api("/api/state")).agents.length > 0);
await shot(page, "session");

// 3. The answer comes back. Opening the card is where you read it.
const name = (await api("/api/state")).agents[0].name;
await page.locator(`text=${name}`).first().click();
await until(async () => (await page.locator("[data-composer]").count()) > 0);
await caption("It works in the code and reports back here. Every tool call is on the timeline.", 0);
await until(async () => (await api("/api/state")).agents[0].status !== "working");
await page.waitForTimeout(800);
await caption("It works in the code and reports back here. Every tool call is on the timeline.");
await shot(page, "answer");

// 4. Not everything is worth saying now. Tab files it instead, and the
//    list opens on what was just filed.
const composer = page.locator("[data-composer]");
await composer.click();
await composer.type("add a test for /health so this cannot regress");
await caption("A thought you do not want to interrupt with: tab files it as work instead.");
await composer.press("Tab");
await until(async () => (await page.getByText("cannot regress").count()) > 0);
await caption("It lands on the task list, and the list opens on what you just filed.");
await shot(page, "filed");

// 5. The inbox is not only for what other people send: you write in it,
//    it holds what you have not decided, and you can throw things away.
await caption("The inbox holds everything undecided -- including what you think of yourself.");
await page.locator('[aria-label="back to the fleet"]').click();
await page.waitForTimeout(600);
const note = page.getByPlaceholder("Something you thought of");
await note.click();
await note.type("the deploy script still points at the old port", { delay: 30 });
await page.waitForTimeout(500);
await shot(page, "note");
await note.press("Enter");
await page.waitForTimeout(900);

await until(async () => (await page.getByText("Send this to").count()) > 0, 30);
await caption("It comes straight back as something waiting on you, on the routing screen.");
await shot(page, "routing-again");
await caption("This one belongs to a session that already exists.");
const tick = page.locator(`[aria-label="send to ${name}"]`).first();
if ((await tick.getAttribute("aria-checked")) !== "true") {
  await tick.click();
  await page.waitForTimeout(500);
}
await page.getByRole("button", { name: /^send to \d+ agent/ }).click();
// The routing screen closes once the thing has somewhere to be.
await until(async () => (await page.getByText("Send this to").count()) === 0, 60);
await page.waitForTimeout(900);
await shot(page, "sent-to-existing");

await caption("Not everything deserves an agent. Some of it you just throw away.");
await api("/api/signal", {
  source: "demo",
  conversation: "C1",
  user: "ops",
  text: "reminder: the office is closed on Friday",
});
await until(async () => (await page.getByText("office is closed").count()) > 0, 60);
await page.getByText("office is closed").first().click();
await page.waitForTimeout(700);
await page.locator('[aria-label="discard"]').click();
await page.waitForTimeout(900);
await caption("What is settled folds away under Done, still there if you want it.");
await shot(page, "discarded");

// 6. The list of what is left: a second thing written down from the fleet,
//    an agent picking work up, and a person deciding when it is finished.
await caption("The task list is what is left to do, for you and for every agent.");
if ((await page.locator("[data-composer]").count()) === 0) {
  await page.locator(`text=${name}`).first().click();
  await page.waitForTimeout(700);
}
if ((await page.locator('[aria-label="Show or hide tasks"]').getAttribute("aria-pressed")) !== "true") {
  await page.locator('[aria-label="Show or hide tasks"]').click();
}
await page.waitForTimeout(800);
await shot(page, "tasks");

await caption("Anyone can add to it -- here, from the fleet, outside any conversation.");
await page.locator('[aria-label="back to the fleet"]').click();
await page.waitForTimeout(700);
await page.getByPlaceholder("Add to the task list").click();
await page.getByPlaceholder("Add to the task list").type("document the /health response in the README", { delay: 30 });
await page.waitForTimeout(600);
await page.getByPlaceholder("Add to the task list").press("Enter");
await until(async () => (await page.getByText("document the /health").count()) > 0, 60);
await page.waitForTimeout(1000);
await shot(page, "second-task");

await caption("Give it to a session and it starts on it, without being asked twice.");
await page
  .locator('[aria-label^="assign document the /health"]')
  .selectOption({ label: (await api("/api/state")).agents[0].name });
await until(async () => (await api("/api/state")).agents[0].status === "working", 90);
await page.locator(`text=${name}`).first().click();
await page.waitForTimeout(1500);
await shot(page, "picked-up");

await caption("It works through the list and says what it did, task by task.", 0);
await until(async () => {
  const tasks = await api("/api/tasks");
  return tasks.some((task) => task.text.startsWith("document the") && task.status === "done");
}, 300);
await page.waitForTimeout(1000);
await caption("An agent can say a task is done. Only you can say it is finished.");
await shot(page, "done");

await caption("Saying no puts the task above the composer, where there is room to answer it.");
await page.getByRole("button", { name: "Not yet" }).first().click();
await page.waitForTimeout(600);
await shot(page, "not-yet");
await page.keyboard.type("say what the commit field is for as well");
await page.waitForTimeout(800);
await caption("What you type goes back to the agent, and the task is work again.");
await shot(page, "correction");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// 7. Saying something by drawing it: the change to the picture is the
//    message, and the file on disk changes with it.
await caption("Some things are quicker drawn than said.");
await page.locator('[aria-label="Attach images options"]').first().click();
await page.waitForTimeout(400);
await page.getByRole("menuitem", { name: /Diagram/ }).click();
await until(async () => (await page.locator("text=Changes").count()) > 0, 60);
await caption("This is the architecture diagram in the repository, drawn from the file.");
await shot(page, "diagram");

await page.locator('[aria-label="new box label"]').fill("health check");
await page.locator('[aria-label="add the box"]').click();
await until(async () => (await page.locator("text=health check").count()) > 0, 60);
await caption("Add a box. Nothing has been sent yet — it is a change you can still take back.");
await shot(page, "drawn");

await page.locator("[data-composer]").fill("this is the endpoint ops are asking about");
await caption("Send it: the file changes, and the agent is told to make the code match the picture.");
await page.getByRole("button", { name: /Send the change/ }).first().click();
await until(async () => (await api("/api/state")).agents[0].status === "working", 60);
await page.waitForTimeout(1500);
await caption("The agent is already working on it.");
await shot(page, "sent");

// 8. The other way to say it without words: draw on a blank page, or on a
//    screenshot, and send the picture.
await caption("Or draw it. A circle round the thing you mean says more than a paragraph.");
await page.locator('[aria-label="Attach images options"]').first().click();
await page.waitForTimeout(500);
await page.getByRole("menuitem", { name: /Draw/ }).click();
await until(async () => (await page.locator('[aria-label="sketch"]').count()) > 0, 60);
await page.waitForTimeout(800);
await shot(page, "draw");

// A hand-drawn arrow and a circle, at the speed a hand draws them.
const sketch = await page.locator('[aria-label="sketch"]').boundingBox();
const stroke = async (points) => {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 12 });
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
};
const spot = (dx, dy) => ({ x: sketch.x + sketch.width * dx, y: sketch.y + sketch.height * dy });
await stroke([spot(0.22, 0.34), spot(0.44, 0.34), spot(0.44, 0.56), spot(0.22, 0.56), spot(0.22, 0.34)]);
await stroke([spot(0.5, 0.45), spot(0.68, 0.45)]);
await stroke([spot(0.62, 0.39), spot(0.68, 0.45), spot(0.62, 0.51)]);
await stroke([spot(0.7, 0.4), spot(0.86, 0.4), spot(0.86, 0.58), spot(0.7, 0.58), spot(0.7, 0.4)]);
await caption("It goes to the agent as a picture, or tab files the drawing as work.");
await shot(page, "drawn-picture");
await page.locator("[data-composer]").fill("the health check belongs behind the router, not beside it");
await page.waitForTimeout(600);
await page.getByRole("button", { name: /Send the picture/ }).first().click();
await until(async () => (await page.locator("img[src*='attachments']").count()) > 0, 90);
// The picture lands at the end of the transcript; look at it.
await page.locator("[data-transcript]").evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
await page.waitForTimeout(1500);
await caption("The agent sees what you drew, in the conversation.");
await shot(page, "picture-sent");

// 9. Branching the work, and the two places a branch can land.
await caption("Branch a session when the work forks.");
await page.locator('[aria-label$="options"]').first().click();
await page.waitForTimeout(700);
await caption("Here, or in a card beside this one.");
await shot(page, "fork");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// 10. The one switch that changes what happens to everything next.
await caption("Or let it route itself: auto sends each thing to the session it belongs to.");
await page.locator('[aria-label="Auto route"]').click();
await page.waitForTimeout(900);
await shot(page, "auto");
await page.locator('[aria-label="Ask me first"]').click();
await page.waitForTimeout(700);

// 11. What little there is to decide.
await page.locator('[title="Settings"]').click();
await page.waitForTimeout(700);
await caption("Four settings, and no more.");
await shot(page, "settings");
await page.getByRole("button", { name: /Dark/ }).click();
await page.waitForTimeout(700);
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
await caption("The same palette, read the other way round.");
await shot(page, "dark");
await page.locator('[title="Settings"]').click();
await page.waitForTimeout(600);
await page.getByRole("button", { name: /Light/ }).click();
await page.waitForTimeout(600);
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// 12. Everything said is searchable, including sessions that were never
//    oxroute's to begin with.
await caption("Everything anyone said is searchable.", 0);
await page.getByPlaceholder("Search sessions").type("health", { delay: 120 });
await page.waitForTimeout(2000);
await caption("Everything anyone said is searchable.");
await caption("Find the line you remember, and land in the session that said it.");
await shot(page, "search");
await page.waitForTimeout(1200);

await caption("", 0);
await card("oxroute", "One inbox, one fleet, one list of what is left.", 6000);

await context.close();
await browser.close();
