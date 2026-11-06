"use strict";
// No browser package or downloads: exercise the installed Chromium through CDP.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, fn, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let failure;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { failure = error; }
    await sleep(60);
  }
  throw new Error(`Timed out: ${label}${failure ? ` (${failure.message.slice(0, 180)})` : ""}`);
}

class CDP {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map(); this.errors = [];
    socket.addEventListener("message", event => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result || {});
      } else if (msg.method === "Runtime.exceptionThrown" && this.errors.length < 20) {
        const d = msg.params.exceptionDetails;
        this.errors.push(d.exception?.description || d.text || "Browser runtime error");
      }
    });
    socket.addEventListener("close", () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("CDP closed")); }
      this.pending.clear();
    });
  }
  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("Cannot connect to Chromium CDP")), { once: true });
    });
    return new CDP(socket);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(session, expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
}

async function launch(root, baseline = false) {
  const candidates = [process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  const executable = candidates.find(p => fs.existsSync(p));
  if (!executable) throw new Error("No Chromium found. Set CHROME_PATH to an existing Chrome/Chromium/Edge executable; no browser is downloaded.");
  const scratch = process.env.HATCHSTONE_TEST_TMP || process.env.TMPDIR || os.tmpdir();
  fs.mkdirSync(scratch, { recursive: true });
  const profile = fs.mkdtempSync(path.join(scratch, "hatchstone-browser-"));
  const baselineRef = process.env.HATCHSTONE_BASE_REF || "HEAD";
  const baselineIndex = baseline ? execFileSync("git", ["show", baselineRef + ":index.html"], { cwd: root, encoding: "utf8" }) : null;
  const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let relative;
    try { relative = decodeURIComponent(url.pathname).replace(/^\/hatchstone\//, ""); } catch { res.writeHead(400).end(); return; }
    if (!url.pathname.startsWith("/hatchstone/") || relative.split(/[\\/]/).some(p => p === ".." || p.startsWith("."))) {
      res.writeHead(404).end(); return;
    }
    if (!relative) relative = "index.html";
    const filename = path.join(root, relative);
    try {
      const body = baseline && relative === "index.html" ? baselineIndex : fs.readFileSync(filename);
      res.writeHead(200, { "Content-Type": mime[path.extname(filename)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/hatchstone/`;
  const chrome = spawn(executable, ["--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--mute-audio",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", d => { stderr = (stderr + d).slice(-2500); });
  let cdp;
  async function close() {
    if (cdp) {
      try { await cdp.send("Browser.close"); } catch {}
      cdp.socket.close();
    }
    if (chrome.exitCode === null) {
      await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), sleep(2000)]);
      if (chrome.exitCode === null) chrome.kill();
    }
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch {}
  }
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    await waitFor("private Chromium startup", () => {
      if (chrome.exitCode !== null) throw new Error(`Chromium exited: ${stderr}`);
      return fs.existsSync(portFile);
    }, 20000);
    const [port, endpoint] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    cdp = await CDP.open(`ws://127.0.0.1:${port}${endpoint}`);
    async function page(width, height) {
      const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__testLoadToken = Math.random().toString(36);" }, sessionId);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      await cdp.send("Page.navigate", { url }, sessionId);
      await waitFor("game initial load", () => cdp.evaluate(sessionId, "document.readyState === 'complete' && !!window.__game"));
      return {
        id: sessionId,
        eval: expression => cdp.evaluate(sessionId, expression),
        click: id => cdp.evaluate(sessionId, `document.getElementById(${JSON.stringify(id)})?.click()`),
        fill: (id, value) => cdp.evaluate(sessionId, `document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; true`),
        async resize(w, h) {
          await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
          await sleep(250);
        },
        async mouse(type, x, y) {
          await cdp.send("Input.dispatchMouseEvent", { type, x, y,
            button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1,
            clickCount: type === "mouseMoved" ? 0 : 1 }, sessionId);
        },
        async tap(x, y) {
          await this.mouse("mousePressed", x, y); await sleep(25); await this.mouse("mouseReleased", x, y);
        },
        async stroke(points) {
          if (!points.length) return;
          await this.mouse("mousePressed", ...points[0]);
          for (const p of points.slice(1)) { await this.mouse("mouseMoved", ...p); await sleep(19); }
          await this.mouse("mouseReleased", ...points[points.length - 1]);
        },
      };
    }
    return { cdp, url, page, close };
  } catch (error) { await close(); throw error; }
}
module.exports = { launch, waitFor, sleep };
