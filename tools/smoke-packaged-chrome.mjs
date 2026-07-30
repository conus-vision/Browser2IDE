import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BROWSER_ARCHIVE_FILES,
  assertExactArchivePaths,
  readArchive,
} from "./verify-artifacts.mjs";

const SERVICE_WORKER_PATH = "/dist/background.js";
const START_TIMEOUT_MS = 20_000;
const CDP_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 100;

export const CHROME_ARCHIVE_FILES = BROWSER_ARCHIVE_FILES;

export function findBrowser2IDEServiceWorker(targets, extensionId) {
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error("Chrome returned an invalid extension id");
  }
  const matches = targets.filter(
    (target) =>
      target?.type === "service_worker" &&
      typeof target.url === "string" &&
      target.url === `chrome-extension://${extensionId}${SERVICE_WORKER_PATH}`,
  );
  if (matches.length > 1) {
    throw new Error("Chrome exposed multiple Browser2IDE service workers");
  }
  return matches[0];
}

export function isBrowser2IDEManifest(manifest) {
  return (
    manifest?.name === "Browser2IDE" &&
    manifest?.version === "0.2.0" &&
    manifest?.manifest_version === 3 &&
    manifest?.background?.service_worker === "dist/background.js"
  );
}

export function validatePackagedChromeArchive(archive) {
  assertExactArchivePaths(
    archive,
    "packaged Chrome smoke artifact",
    CHROME_ARCHIVE_FILES,
  );
  let manifest;
  try {
    manifest = JSON.parse(archive.files.get("manifest.json").toString("utf8"));
  } catch (error) {
    throw new Error(`Chrome artifact contains invalid manifest.json: ${error.message}`);
  }
  if (!isBrowser2IDEManifest(manifest)) {
    throw new Error("Chrome artifact does not declare the expected MV3 service worker");
  }
  return manifest;
}

export function buildChromeArguments(profileDirectory) {
  if (!isAbsolute(profileDirectory)) {
    throw new Error("Chrome smoke profile directory must be absolute");
  }
  return [
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-crash-reporter",
    "--disable-default-apps",
    "--disable-sync",
    "--enable-unsafe-extension-debugging",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    "--window-position=-32000,-32000",
    "--window-size=800,600",
    "about:blank",
  ];
}

export function chromeExecutableCandidates(platform, environment) {
  const override = environment.CHROME_EXECUTABLE_PATH?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error("CHROME_EXECUTABLE_PATH must be absolute");
    }
    return [override];
  }
  if (platform === "win32") {
    return [
      [environment.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"],
      [environment["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"],
      [environment.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"],
    ]
      .filter(([root]) => typeof root === "string" && root.length > 0)
      .map((parts) => join(...parts));
  }
  if (platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
}

export async function smokePackagedChrome(artifactArgument) {
  if (!artifactArgument) {
    throw new Error(
      "Usage: node tools/smoke-packaged-chrome.mjs <path-to-chrome-zip>",
    );
  }

  const artifactPath = resolve(process.cwd(), artifactArgument);
  await access(artifactPath);
  const archive = readArchive(artifactPath, "packaged Chrome smoke artifact");
  const manifest = validatePackagedChromeArchive(archive);

  let smokeRoot;
  let chrome;
  let cdp;
  let spawnError;
  let stderr = "";
  try {
    smokeRoot = await mkdtemp(join(tmpdir(), "browser2ide-chrome-smoke-"));
    const extensionDirectory = join(smokeRoot, "extension");
    const profileDirectory = join(smokeRoot, "profile");
    await Promise.all([
      mkdir(extensionDirectory, { recursive: true }),
      mkdir(profileDirectory, { recursive: true }),
    ]);
    await extractValidatedArchive(archive, extensionDirectory);

    const executable = await findChromeExecutable();
    chrome = spawn(
      executable,
      buildChromeArguments(profileDirectory),
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    chrome.once("error", (error) => {
      spawnError = error;
    });
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk;
    });

    const portFile = join(profileDirectory, "DevToolsActivePort");
    const [portText, browserPath] = (
      await waitForTextFile(portFile, chrome, () => spawnError)
    ).split(/\r?\n/);
    const port = Number(portText);
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browserPath ?? "")
    ) {
      throw new Error("Chrome wrote an invalid DevToolsActivePort file");
    }

    cdp = await openCdp(`ws://127.0.0.1:${port}${browserPath}`);
    const { product } = await cdp.send("Browser.getVersion");
    if (!/^Chrome\/\d+(?:\.\d+){3}$/.test(product)) {
      throw new Error(`Expected Google Chrome Stable, received ${product}`);
    }
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", {
      path: extensionDirectory,
    });
    const { extensions } = await cdp.send("Extensions.getExtensions");
    const installed = extensions.find((extension) => extension.id === extensionId);
    if (
      !installed?.enabled ||
      installed.name !== manifest.name ||
      installed.version !== manifest.version ||
      resolve(installed.path) !== resolve(extensionDirectory)
    ) {
      throw new Error("Chrome did not report the expected unpacked Browser2IDE extension");
    }
    await waitForServiceWorker(cdp, chrome, extensionId);
    console.log(
      `PACKAGED_CHROME_MV3_OK ${product} ${manifest.name} ${manifest.version} ${extensionId}${SERVICE_WORKER_PATH}`,
    );
  } catch (error) {
    const details = stderr.trim();
    if (details) {
      throw new Error(`${error.message}\nChrome stderr:\n${details}`);
    }
    throw error;
  } finally {
    if (cdp) {
      try {
        await cdp.send("Browser.close");
      } catch {
        // Chrome may close the socket before acknowledging Browser.close.
      }
      cdp.close();
    }
    if (chrome && isChildRunning(chrome)) {
      try {
        await waitForExit(chrome, STOP_TIMEOUT_MS);
      } catch {
        chrome.kill();
        await waitForExit(chrome, STOP_TIMEOUT_MS).catch(() => undefined);
      }
    }
    if (smokeRoot) {
      await rm(smokeRoot, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  }
}

async function extractValidatedArchive(archive, destination) {
  for (const path of CHROME_ARCHIVE_FILES) {
    const data = archive.files.get(path);
    const output = join(destination, ...path.split("/"));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, data, { flag: "wx" });
  }
}

async function findChromeExecutable() {
  const candidates = chromeExecutableCandidates(process.platform, process.env);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next conventional installation path.
    }
  }
  throw new Error("Chrome Stable was not found; set CHROME_EXECUTABLE_PATH");
}

async function waitForTextFile(path, process_, getSpawnError) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assertChildRunning(process_, getSpawnError(), "CDP was ready");
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for Chrome DevToolsActivePort");
}

async function waitForServiceWorker(cdp, process_, extensionId) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastTargets = [];
  while (Date.now() < deadline) {
    assertChildRunning(process_, undefined, "the service worker loaded");
    const { targetInfos } = await cdp.send("Target.getTargets");
    lastTargets = targetInfos;
    const target = findBrowser2IDEServiceWorker(targetInfos, extensionId);
    if (target) return target;
    await delay(POLL_INTERVAL_MS);
  }
  const summary = lastTargets
    .map(({ type, url }) => `${type}:${url}`)
    .filter(Boolean)
    .join(", ");
  throw new Error(
    `Timed out waiting for the packaged Browser2IDE service worker; CDP targets: ${summary || "none"}`,
  );
}

export async function openCdp(
  url,
  { WebSocketClass = globalThis.WebSocket, timeoutMs = CDP_TIMEOUT_MS } = {},
) {
  const socket = new WebSocketClass(url);
  await new Promise((resolve_, reject) => {
    let settled = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      callback();
    };
    const onOpen = () => finish(resolve_);
    const onError = () => finish(() => reject(new Error("CDP WebSocket failed to open")));
    timer = setTimeout(() => {
      finish(() => {
        socket.close();
        reject(new Error("Timed out opening the CDP WebSocket"));
      });
    }, timeoutMs);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const rejectPending = (message) => {
    for (const { method, reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`CDP ${method}: ${message}`));
    }
    pending.clear();
  };
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      rejectPending("received invalid JSON");
      socket.close();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(new Error(`CDP ${request.method}: ${message.error.message}`));
    } else {
      request.resolve(message.result ?? {});
    }
  });
  socket.addEventListener("close", () => {
    closed = true;
    rejectPending("WebSocket closed");
  });
  socket.addEventListener("error", () => rejectPending("WebSocket error"));
  return {
    close: () => {
      closed = true;
      rejectPending("client closed");
      if (socket.readyState < 2) socket.close();
    },
    send(method, params = {}, sessionId) {
      if (closed || socket.readyState !== 1) {
        return Promise.reject(new Error(`CDP ${method}: WebSocket is not open`));
      }
      const id = ++nextId;
      return new Promise((resolve_, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method}: timed out`));
        }, timeoutMs);
        pending.set(id, { method, resolve: resolve_, reject, timer });
        try {
          socket.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
          );
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
  };
}

function waitForExit(process_, timeout) {
  if (!isChildRunning(process_)) return Promise.resolve();
  return new Promise((resolve_, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      process_.removeListener("exit", onExit);
      process_.removeListener("error", onError);
    };
    const onExit = () => {
      cleanup();
      resolve_();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Chrome did not exit in time"));
    }, timeout);
    process_.once("exit", onExit);
    process_.once("error", onError);
  });
}

function isChildRunning(process_) {
  return process_.exitCode === null && process_.signalCode === null;
}

function assertChildRunning(process_, spawnError, expectedState) {
  if (spawnError) {
    throw new Error(`Chrome failed to start: ${spawnError.message}`);
  }
  if (!isChildRunning(process_)) {
    const outcome = process_.exitCode === null
      ? `signal ${process_.signalCode}`
      : `exit code ${process_.exitCode}`;
    throw new Error(`Chrome exited before ${expectedState} (${outcome})`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve_) => setTimeout(resolve_, milliseconds));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await smokePackagedChrome(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
