import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { SourceWorkspace } from "@browser2ide/plugin-api";
import {
  SOURCE_MAP_CACHE_LIMIT,
  SourceMapLoader,
} from "../src/sourcePlugins/sourceMapLoader.js";

const rawMap = {
  version: 3,
  file: "app.css",
  sourceRoot: "",
  sources: ["../src/app.scss"],
  names: [],
  mappings: "AAAA",
};

describe("SourceMapLoader", () => {
  it("loads an external source map relative to generated CSS", async () => {
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": JSON.stringify(rawMap),
    });
    const loaded = await new SourceMapLoader().load(
      "file:///workspace/dist/app.css",
      "a{}\n/*# sourceMappingURL=app.css.map */",
      workspace,
    );

    expect(loaded.mapUri).toBe("file:///workspace/dist/app.css.map");
    expect(loaded.rawMap?.sources).toEqual(["../src/app.scss"]);
    expect(loaded.diagnostics).toEqual([]);
  });

  it("loads base64 and percent-encoded inline source maps", async () => {
    const json = JSON.stringify(rawMap);
    const encoded = Buffer.from(json).toString("base64");
    const loader = new SourceMapLoader();
    const base64 = await loader.load(
      "file:///workspace/dist/app.css",
      `a{}\n/*# sourceMappingURL=data:application/json;base64,${encoded} */`,
      memoryWorkspace({}),
    );
    const percent = await loader.load(
      "file:///workspace/dist/other.css",
      `a{}\n/*# sourceMappingURL=data:application/json,${encodeURIComponent(json)} */`,
      memoryWorkspace({}),
    );

    expect(base64.mapUri).toBe(
      "file:///workspace/dist/app.css#inline-source-map",
    );
    expect(base64.rawMap?.file).toBe("app.css");
    expect(percent.rawMap?.sources).toEqual(["../src/app.scss"]);
  });

  it("uses the last directive and reports missing or invalid maps", async () => {
    const loader = new SourceMapLoader();
    const missing = await loader.load(
      "file:///workspace/dist/app.css",
      "a{}",
      memoryWorkspace({}),
    );
    const invalid = await loader.load(
      "file:///workspace/dist/app.css",
      "a{}\n/*# sourceMappingURL=invalid.map */",
      memoryWorkspace({
        "file:///workspace/dist/invalid.map": "{not-json",
      }),
    );
    const last = await loader.load(
      "file:///workspace/dist/app.css",
      "/*# sourceMappingURL=missing.map */\na{}\n/*# sourceMappingURL=valid.map */",
      memoryWorkspace({
        "file:///workspace/dist/valid.map": JSON.stringify(rawMap),
      }),
    );

    expect(missing.diagnostics[0]?.code).toBe("scss.sourceMapMissing");
    expect(invalid.diagnostics[0]?.code).toBe("scss.sourceMapInvalid");
    expect(last.mapUri).toBe("file:///workspace/dist/valid.map");
  });

  it("aborts an external map read without parsing a late result", async () => {
    const controller = new AbortController();
    let finishRead: ((value: string) => void) | undefined;
    const workspace = memoryWorkspace({});
    workspace.readText = () => new Promise((resolve) => {
      finishRead = resolve;
    });
    const pending = new SourceMapLoader().load(
      "file:///workspace/dist/app.css",
      "a{}\n/*# sourceMappingURL=app.css.map */",
      workspace,
      controller.signal,
    );
    await Promise.resolve();

    controller.abort();
    finishRead?.(JSON.stringify(rawMap));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reuses the current map and evicts least-recent historical maps", async () => {
    const loader = new SourceMapLoader();
    const workspace = memoryWorkspace({});
    const first = await loadInlineMap(loader, workspace, "first");
    const current = await loadInlineMap(loader, workspace, "current");
    for (let index = 0; index < SOURCE_MAP_CACHE_LIMIT - 2; index += 1) {
      await loadInlineMap(loader, workspace, `filler-${index}`);
    }

    expect((await loadInlineMap(loader, workspace, "current")).rawMap).toBe(
      current.rawMap,
    );
    await loadInlineMap(loader, workspace, "overflow");

    expect((await loadInlineMap(loader, workspace, "current")).rawMap).toBe(
      current.rawMap,
    );
    expect((await loadInlineMap(loader, workspace, "first")).rawMap).not.toBe(
      first.rawMap,
    );
  });
});

async function loadInlineMap(
  loader: SourceMapLoader,
  workspace: SourceWorkspace,
  name: string,
) {
  const map = JSON.stringify({ ...rawMap, file: `${name}.css` });
  return loader.load(
    `file:///workspace/dist/${name}.css`,
    `a{}\n/*# sourceMappingURL=data:application/json,${encodeURIComponent(map)} */`,
    workspace,
  );
}

function memoryWorkspace(
  files: Readonly<Record<string, string>>,
): SourceWorkspace {
  return {
    findFiles: async () => [],
    async readText(uri) {
      const text = files[uri];
      if (text === undefined) throw new Error(`Missing fixture: ${uri}`);
      return text;
    },
    resolveSourceUri: async () => ({ uris: [], status: "not-found" }),
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: (uri) => uri.startsWith("file:///workspace/"),
  };
}
