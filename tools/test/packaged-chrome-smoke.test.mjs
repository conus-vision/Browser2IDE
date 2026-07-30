import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHROME_ARCHIVE_FILES,
  buildChromeArguments,
  chromeExecutableCandidates,
  findBrowser2IDEServiceWorker,
  isBrowser2IDEManifest,
  openCdp,
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
