// Verify the energy-charge fx (gauge drag + bean pick) renders without
// errors and actually produces DOM elements mid-animation.
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const outDir = process.argv[2] || "brewdeck-fx-shots";
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
for (const digit of cfg.pin) {
  await page.evaluate((d) => {
    for (const b of document.querySelectorAll("#pad button")) if (b.textContent === d) b.click();
  }, digit);
  await sleep(100);
}
await sleep(800);

// drag gauge to max (DEATH WISH) and capture mid-burst
await page.evaluate(() => {
  const svg = document.getElementById("gauge");
  const r = svg.getBoundingClientRect();
  svg.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.right - 8, clientY: r.bottom - 8, bubbles: true }));
});
await sleep(90);
const fxCountGauge = await page.evaluate(() => document.querySelectorAll("#fx-layer .fx-ring, #fx-layer .fx-spark").length);
await shot("fx1-gauge-max-midburst");
await sleep(700);
await shot("fx2-gauge-max-settled");
const fxCountAfter = await page.evaluate(() => document.querySelectorAll("#fx-layer .fx-ring, #fx-layer .fx-spark").length);

// click the last (highest-depth) bean and capture mid-burst
await page.evaluate(() => document.querySelectorAll(".bag")[0].click()); // reset to first so next click is a real "change"
await sleep(500);
await page.evaluate(() => {
  const bags = document.querySelectorAll(".bag");
  bags[bags.length - 1].click();
});
await sleep(90);
const fxCountBean = await page.evaluate(() => document.querySelectorAll("#fx-layer .fx-ring, #fx-layer .fx-spark").length);
const fxPositions = await page.evaluate(() =>
  [...document.querySelectorAll("#fx-layer .fx-ring, #fx-layer .fx-spark")].map((el) => el.style.left + "," + el.style.top)
);
console.log("fx positions (should not all be 0px,0px):", fxPositions.slice(0, 4).join(" | "));
await shot("fx3-bean-fable-midburst");
await sleep(700);

await browser.close();
console.log("fx elements during gauge burst:", fxCountGauge, "| after settle (should be 0):", fxCountAfter);
console.log("fx elements during bean burst:", fxCountBean);
console.log("errors:", errors.length);
for (const e of errors) console.log("  ERR:", e.slice(0, 300));
const fail = errors.length > 0 || fxCountGauge === 0 || fxCountBean === 0 || fxCountAfter !== 0;
process.exit(fail ? 1 : 0);
