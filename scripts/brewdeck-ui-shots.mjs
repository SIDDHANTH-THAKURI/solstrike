// Visual check of the BREWDECK mobile UI (server must be running).
// Run from randomnreproject (has puppeteer): node scripts/brewdeck-ui-shots.mjs <outDir>

import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const outDir = process.argv[2] || "brewdeck-shots";
fs.mkdirSync(outDir, { recursive: true });
const cfg = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), "OneDrive", "Desktop", "brewdeck", "brewdeck.config.json"), "utf8")
);

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--ignore-certificate-errors", "--enable-unsafe-swiftshader", "--mute-audio"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => {
  await page.screenshot({ path: path.join(outDir, n + ".png") });
  console.log("shot:", n);
};

await page.goto(`https://localhost:${cfg.port}/`, { waitUntil: "networkidle0" });
await sleep(600);
await shot("u1-lock");

// tap PIN via pad buttons
for (const digit of cfg.pin) {
  await page.evaluate((d) => {
    for (const b of document.querySelectorAll("#pad button")) {
      if (b.textContent === d) {
        b.click();
        return;
      }
    }
  }, digit);
  await sleep(120);
}
await sleep(1000);
await shot("u2-main");

// select fable bean + max pressure
await page.evaluate(() => {
  const bags = document.querySelectorAll(".bag");
  bags[bags.length - 1].click();
});
await sleep(400);
await page.evaluate(() => {
  const svg = document.getElementById("gauge");
  const r = svg.getBoundingClientRect();
  svg.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.right - 6, clientY: r.bottom - 6, bubbles: true }));
});
await sleep(500);
await shot("u3-fable-max");

// usage tab
await page.evaluate(() => document.getElementById("tab-btn").click());
await sleep(1800);
await shot("u4-tab");
await page.evaluate(() => document.getElementById("sheet-veil").click());

// workspace sheet
await page.evaluate(() => document.getElementById("ws-chip").click());
await sleep(400);
await shot("u5-workspaces");
await page.evaluate(() => document.getElementById("sheet-veil").click());

// typing panel
await page.evaluate(() => document.getElementById("kbd-btn").click());
await sleep(300);
await shot("u6-typing");

await browser.close();
console.log("\nerrors:", errors.length);
for (const e of errors) console.log("  ERR:", e.slice(0, 300));
process.exit(errors.length ? 1 : 0);
