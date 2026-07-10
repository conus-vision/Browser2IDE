import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const virtualCss = ".card { border-style: solid; border-width: 2px; }\n";
const vendorCss = ".card { box-sizing: border-box; }\n";
const staticFiles = new Map([
  ["/dist/app.css", ["dist/app.css", "text/css; charset=utf-8"]],
  ["/dist/app.css.map", ["dist/app.css.map", "application/json; charset=utf-8"]],
  ["/fallback.css", ["fallback.css", "text/css; charset=utf-8"]],
]);

export async function startExampleServers(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const vendorServer = createServer((request, response) => {
    if (request.url !== "/vendor.css") {
      send(response, 404, "Not found\n", "text/plain; charset=utf-8");
      return;
    }
    send(response, 200, vendorCss, "text/css; charset=utf-8", {
      "Access-Control-Allow-Origin": "*",
    });
  });
  await listen(vendorServer, host, options.vendorPort ?? 4_174);
  const vendorCssUrl = `http://${host}:${listeningPort(vendorServer)}/vendor.css`;

  const pageServer = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/" || pathname === "/index.html") {
        const template = await readFile(resolve(fixtureRoot, "index.html"), "utf8");
        send(
          response,
          200,
          template.replace("__VENDOR_CSS_URL__", vendorCssUrl),
          "text/html; charset=utf-8",
        );
        return;
      }
      if (pathname === "/virtual.css") {
        send(response, 200, virtualCss, "text/css; charset=utf-8");
        return;
      }
      const staticFile = staticFiles.get(pathname);
      if (!staticFile) {
        send(response, 404, "Not found\n", "text/plain; charset=utf-8");
        return;
      }
      const [relativePath, contentType] = staticFile;
      const body = await readFile(resolve(fixtureRoot, relativePath));
      send(response, 200, body, contentType);
    } catch (error) {
      send(
        response,
        500,
        `${error instanceof Error ? error.message : String(error)}\n`,
        "text/plain; charset=utf-8",
      );
    }
  });

  try {
    await listen(pageServer, host, options.pagePort ?? 4_173);
  } catch (error) {
    await close(vendorServer);
    throw error;
  }

  let stopped = false;
  return {
    pageUrl: `http://${host}:${listeningPort(pageServer)}/`,
    vendorCssUrl,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      await Promise.all([close(pageServer), close(vendorServer)]);
    },
  };
}

function send(response, status, body, contentType, headers = {}) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function listen(server, host, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
}

function close(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

function listeningPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Example server has no TCP address");
  }
  return address.port;
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  const servers = await startExampleServers();
  console.log(`Browser2IDE example: ${servers.pageUrl}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void servers.stop().finally(() => process.exit(0));
    });
  }
}
