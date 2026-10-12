import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = new URL("./virtual-list.html", import.meta.url).href;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

try {
  await page.goto(pageUrl);
  await page.addScriptTag({ path: path.join(root, "../src/engine.js") });
  page.setDefaultTimeout(90_000);

  const result = await page.evaluate(async () => {
    const session = Scrollback.createSession();
    const done = new Promise((resolve) => {
      const stop = session.subscribe((state) => {
        if (state.phase === "done" || state.phase === "error") {
          stop();
          resolve(state);
        }
      });
    });
    session.start({
      mode: "full",
      settings: {
        preset: "fast",
        stepRatio: 0.72,
        delayMs: 30,
        settleMs: 20,
        includeAttachments: true,
        includeEmbeds: true,
        includeReplies: true,
        includeReactions: false,
        compact: false,
        maxMessages: 0,
        endHoldMs: 1500,
        autoDownload: false,
      },
    });
    const state = await done;
    return {
      phase: state.phase,
      statusMessage: state.statusMessage,
      captured: state.captured,
      recoveries: state.recoveries,
      channelName: state.channelName,
      text: session.buildText(),
    };
  });

  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }

  const numbers = [...result.text.matchAll(/Message number (\d+) hello/g)].map((match) => Number(match[1]));
  const unique = new Set(numbers);
  const missing = [];
  for (let i = 0; i < 180; i++) if (!unique.has(i)) missing.push(i);
  const oldestFirst =
    result.text.indexOf("Message number 0 hello") < result.text.indexOf("Message number 179 hello");
  const checks = [
    ["phase", result.phase === "done", result.phase],
    ["captured", result.captured === 180, result.captured],
    ["missing", missing.length === 0, missing.slice(0, 12).join(",")],
    ["order", oldestFirst, "newest appeared before oldest"],
    ["attachment", result.text.includes("attachment: https://cdn.discordapp.com/attachments/1/2/file-0.png"), "file-0"],
    ["emoji", result.text.includes(":wave:"), "emoji alt"],
    ["reply", result.text.includes("reply to User 0: earlier note"), "reply"],
    ["embed", result.text.includes("embed: Embed title — Embed body"), "embed"],
    ["author fill", /User 0\n {2}Message number 1 hello/.test(result.text), "grouped author"],
    ["channel", result.channelName === "general", result.channelName],
    ["no divider", !result.text.includes("skip me"), "divider leaked"],
  ];

  console.log(
    JSON.stringify(
      {
        phase: result.phase,
        captured: result.captured,
        recoveries: result.recoveries,
        statusMessage: result.statusMessage,
        missing: missing.length,
      },
      null,
      2
    )
  );

  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, , detail] of failed) console.error(`FAIL ${name}: ${detail}`);
  if (failed.length) process.exitCode = 1;
  else console.log("virtual list export passed");
} finally {
  await browser.close();
}
