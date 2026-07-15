// Try flag combos until headless WebGL2 works; prints the winning combo.
import puppeteer from "puppeteer";

const combos = [
  ["--no-sandbox", "--enable-unsafe-swiftshader"],
  ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
  ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=swiftshader"],
  ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
  ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader-webgl"],
  ["--no-sandbox"],
];

for (const args of combos) {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: [...args, "--mute-audio"] });
    const page = await browser.newPage();
    const info = await page.evaluate(() => {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2");
      if (!gl) return null;
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "webgl2-ok";
    });
    console.log(info ? "WORKS" : "fails", "|", args.join(" "), "|", info);
    await browser.close();
    if (info) break;
  } catch (e) {
    console.log("crash |", args.join(" "), "|", e.message.slice(0, 80));
    if (browser) await browser.close();
  }
}
