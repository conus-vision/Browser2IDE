import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  CHROME_ARCHIVE_FILES,
  assertLinuxGraphicalSession,
  buildChromeArguments,
  buildChromeSpawnOptions,
  chromeExecutableCandidates,
  findBrowser2IDEServiceWorker,
  isBrowser2IDEManifest,
  openCdp,
  shutdownOwnedChildTree,
  validatePackagedChromeArchive,
} from "../smoke-packaged-chrome.mjs";

function createArchive(paths = CHROME_ARCHIVE_FILES) {
  const files = new Map(paths.map((path) => [path, Buffer.from(path)]));
  files.set(
    "manifest.json",
    Buffer.from(
      JSON.stringify({
        name: "Browser2IDE",
        version: "0.2.0",
        manifest_version: 3,
        background: { service_worker: "dist/background.js" },
      }),
    ),
  );
  return { files, paths: [...paths] };
}

test("accepts only the exact validated Chrome runtime archive", () => {
  assert.equal(
    validatePackagedChromeArchive(createArchive()).name,
    "Browser2IDE",
  );
  assert.throws(
    () =>
      validatePackagedChromeArchive(
        createArchive([...CHROME_ARCHIVE_FILES, "unexpected.txt"]),
      ),
    /unexpected archive path unexpected\.txt/,
  );
});

test("launch arguments always isolate Chrome in the supplied temporary profile", () => {
  const profile = "C:\\Temp\\browser2ide-smoke\\profile";
  const args = buildChromeArguments(profile);

  assert.ok(args.includes(`--user-data-dir=${profile}`));
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.equal(args.some((argument) => argument.startsWith("--profile-directory")), false);
  assert.equal(args.some((argument) => argument.includes("User Data")), false);
});

test("Chrome candidates never become relative when environment roots are absent", () => {
  const candidates = chromeExecutableCandidates("win32", {});
  assert.deepEqual(candidates, []);
  assert.deepEqual(chromeExecutableCandidates("linux", {}), [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]);
});

test("Linux packaged smoke requires a graphical session or Xvfb", () => {
  assert.throws(
    () => assertLinuxGraphicalSession("linux", {}),
    /graphical session or Xvfb/,
  );
  assert.doesNotThrow(() => assertLinuxGraphicalSession("linux", { DISPLAY: ":99" }));
  assert.doesNotThrow(() =>
    assertLinuxGraphicalSession("linux", { WAYLAND_DISPLAY: "wayland-0" }),
  );
  assert.doesNotThrow(() => assertLinuxGraphicalSession("win32", {}));
});

test("Chrome spawn owns a POSIX process group without detaching on Windows", () => {
  assert.equal(buildChromeSpawnOptions("linux").detached, true);
  assert.equal(buildChromeSpawnOptions("darwin").detached, true);
  assert.equal(buildChromeSpawnOptions("win32").detached, false);
});

test("owned Windows child shutdown escalates to its exact PID tree", async () => {
  const child = mockRunningChild(4321);
  const calls = [];
  let waits = 0;
  const cdp = {
    async send(method) {
      calls.push(["cdp", method]);
    },
    close() {
      calls.push(["cdp-close"]);
    },
  };

  await shutdownOwnedChildTree({
    child,
    cdp,
    platform: "win32",
    timeoutMs: 10,
    waitForExitFn: async () => {
      waits += 1;
      calls.push(["wait", waits]);
      if (waits === 1) throw new Error("still running");
      child.exitCode = 0;
    },
    spawnSyncFn(command, arguments_, options) {
      calls.push(["force", command, arguments_, options]);
      return { status: 0, signal: null, stderr: Buffer.alloc(0) };
    },
  });

  assert.deepEqual(calls.slice(0, 4), [
    ["cdp", "Browser.close"],
    ["cdp-close"],
    ["wait", 1],
    ["force", "taskkill", ["/PID", "4321", "/T", "/F"], {
      encoding: "utf8",
      timeout: 10,
      windowsHide: true,
    }],
  ]);
  assert.deepEqual(calls.at(-1), ["wait", 2]);
});

test("owned POSIX child shutdown targets only its detached process group", async () => {
  const child = mockRunningChild(7654);
  const kills = [];
  let waits = 0;

  await shutdownOwnedChildTree({
    child,
    platform: "linux",
    timeoutMs: 10,
    waitForExitFn: async () => {
      waits += 1;
      if (waits === 1) throw new Error("still running");
      child.signalCode = "SIGKILL";
    },
    killFn(pid, signal) {
      kills.push([pid, signal]);
    },
  });

  assert.deepEqual(kills, [[-7654, "SIGKILL"]]);
});

test("owned child shutdown reports a final cleanup failure", async () => {
  const child = mockRunningChild(2468);
  await assert.rejects(
    shutdownOwnedChildTree({
      child,
      platform: "win32",
      timeoutMs: 10,
      waitForExitFn: async () => {
        throw new Error("still running");
      },
      spawnSyncFn: () => ({ status: 0, signal: null, stderr: Buffer.alloc(0) }),
    }),
    /Chrome cleanup failed: owned child tree PID 2468 is still running/,
  );
});

test("CDP connection and commands have bounded timeouts", async () => {
  let unopenedSocket;
  class UnopenedSocket extends EventTarget {
    readyState = 0;

    constructor() {
      super();
      unopenedSocket = this;
    }

    close() {
      this.readyState = 3;
    }
  }

  await assert.rejects(
    openCdp("ws://127.0.0.1:1/devtools/browser/test", {
      WebSocketClass: UnopenedSocket,
      timeoutMs: 10,
    }),
    /Timed out opening/,
  );
  assert.equal(unopenedSocket.readyState, 3);

  class UnresponsiveSocket extends EventTarget {
    readyState = 0;

    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }

    send() {}

    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }

  const cdp = await openCdp("ws://127.0.0.1:1/devtools/browser/test", {
    WebSocketClass: UnresponsiveSocket,
    timeoutMs: 10,
  });
  await assert.rejects(cdp.send("Browser.getVersion"), /timed out/);
  cdp.close();
});

test("CDP runtime errors dispose listeners and reject pending requests", async () => {
  let socket;
  class TrackingSocket {
    readyState = 0;
    closeCalls = 0;
    listeners = new Map();

    constructor() {
      socket = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    emit(type, event) {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    }

    send() {}

    close() {
      this.closeCalls += 1;
      this.readyState = 3;
      this.emit("close", {});
    }

    listenerCount(type) {
      return this.listeners.get(type)?.size ?? 0;
    }
  }

  const cdp = await openCdp("ws://127.0.0.1:1/devtools/browser/test", {
    WebSocketClass: TrackingSocket,
    timeoutMs: 50,
  });
  const pending = cdp.send("Browser.getVersion");
  socket.emit("error", {});

  await assert.rejects(pending, /WebSocket error/);
  await assert.rejects(cdp.send("Target.getTargets"), /WebSocket is not open/);
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(socket.listenerCount("close"), 0);
  assert.equal(socket.listenerCount("error"), 0);
  cdp.close();
  assert.equal(socket.closeCalls, 1);
});

test("finds the packaged Browser2IDE MV3 service worker", () => {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const target = findBrowser2IDEServiceWorker([
    { type: "page", url: "about:blank" },
    {
      targetId: "worker-1",
      type: "service_worker",
      url: `chrome-extension://${extensionId}/dist/background.js`,
    },
  ], extensionId);

  assert.equal(target?.targetId, "worker-1");
});

test("ignores unrelated workers and non-extension targets", () => {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  assert.equal(
    findBrowser2IDEServiceWorker([
      {
        targetId: "worker-1",
        type: "service_worker",
        url: "https://example.test/service-worker.js",
      },
      {
        targetId: "worker-2",
        type: "worker",
        url: `chrome-extension://${extensionId}/dist/background.js`,
      },
    ], extensionId),
    undefined,
  );
});

test("rejects ambiguous Browser2IDE service workers", () => {
  const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.throws(
    () =>
      findBrowser2IDEServiceWorker([
        {
          targetId: "worker-1",
          type: "service_worker",
          url: `chrome-extension://${extensionId}/dist/background.js`,
        },
        {
          targetId: "worker-2",
          type: "service_worker",
          url: `chrome-extension://${extensionId}/dist/background.js`,
        },
      ], extensionId),
    /multiple Browser2IDE service workers/,
  );
});

test("recognizes Browser2IDE by the manifest exposed inside its worker", () => {
  assert.equal(
    isBrowser2IDEManifest({
      name: "Browser2IDE",
      version: "0.2.0",
      manifest_version: 3,
      background: { service_worker: "dist/background.js" },
    }),
    true,
  );
  assert.equal(
    isBrowser2IDEManifest({
      name: "Unrelated extension",
      version: "0.2.0",
      manifest_version: 3,
      background: { service_worker: "dist/background.js" },
    }),
    false,
  );
});

function mockRunningChild(pid) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
  });
}
