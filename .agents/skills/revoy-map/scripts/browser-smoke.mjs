#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [browser, artifact] = process.argv.slice(2);
if (!browser || !existsSync(browser) || !artifact || !existsSync(artifact)) {
  process.stdout.write(JSON.stringify({ ok: false, error: "browser and artifact paths are required" }) + "\n");
  process.exit(1);
}

const profile = mkdtempSync(resolve(tmpdir(), "revoy-map-browser-"));
const downloads = resolve(profile, "downloads");
const child = spawn(browser, [
  "--headless",
  "--no-sandbox",
  "--disable-gpu",
  "--remote-allow-origins=*",
  "--remote-debugging-port=0",
  "--user-data-dir=" + profile,
  "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });

function endpoint() {
  return new Promise((resolveEndpoint, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("DevTools endpoint timeout")), 10000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolveEndpoint(match[1]);
      }
    });
    child.once("exit", (code) => reject(new Error("browser exited before DevTools endpoint: " + code)));
  });
}

function connect(url) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolveSocket(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

try {
  const socket = await connect(await endpoint());
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolveCall, rejectCall } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectCall(new Error(message.error.message));
    else resolveCall(message.result);
  });
  function call(method, params = {}, sessionId) {
    return new Promise((resolveCall, rejectCall) => {
      const id = nextId++;
      pending.set(id, { resolveCall, rejectCall });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  await call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  const target = await call("Target.createTarget", { url: pathToFileURL(resolve(artifact)).href });
  const attached = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await call("Runtime.enable", {}, sessionId);
  await call("Runtime.evaluate", { expression: "document.readyState === 'complete' ? true : new Promise(resolve => addEventListener('load', () => resolve(true), {once:true}))", awaitPromise: true, returnByValue: true }, sessionId);
  const ready = await call("Runtime.evaluate", { expression: "Boolean(window.RevoyMap && document.documentElement.dataset.runtimeReady === 'true')", returnByValue: true }, sessionId);
  const formats = ["svg", "png", "jpeg", "webp", "share", "webm"];
  for (const format of formats) {
    await call("Runtime.evaluate", { expression: "window.RevoyMap.exportArtifact(" + JSON.stringify(format) + ")", awaitPromise: true, returnByValue: true }, sessionId);
  }
  const expected = ["revoy-map.svg", "revoy-map.png", "revoy-map.jpeg", "revoy-map.webp", "revoy-map.share-card.png", "revoy-map.webm"];
  const deadline = Date.now() + 15000;
  let files = [];
  while (Date.now() < deadline) {
    try { files = readdirSync(downloads); } catch {}
    if (expected.every((name) => files.includes(name)) && !files.some((name) => name.endsWith(".crdownload"))) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  const missing = expected.filter((name) => !files.includes(name));
  const result = { ok: ready.result.value === true && missing.length === 0, runtimeReady: ready.result.value === true, downloads, files: files.sort(), missing };
  process.stdout.write(JSON.stringify(result) + "\n");
  socket.close();
  child.kill("SIGTERM");
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  child.kill("SIGTERM");
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + "\n");
  process.exitCode = 1;
}
