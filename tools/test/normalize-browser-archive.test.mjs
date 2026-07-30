import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { withTemporaryDirectory } from "./test-helpers.mjs";
import { normalizeBrowserArchive } from "../normalize-browser-archive.mjs";

test("browser archive normalization sorts files and fixes timestamps", async () => {
  await withTemporaryDirectory("browser2ide-normalize-", async (directory) => {
    const path = resolve(directory, "extension.zip");
    const zip = new AdmZip();
    zip.addFile("z.txt", Buffer.from("last"));
    zip.addFile("dist/", Buffer.alloc(0));
    zip.addFile("dist/a.txt", Buffer.from("first"));
    zip.writeZip(path);

    await normalizeBrowserArchive(path);
    const first = await readFile(path);
    const entries = new AdmZip(path).getEntries();
    assert.deepEqual(entries.map((entry) => entry.entryName), ["dist/a.txt", "z.txt"]);
    assert.deepEqual(
      entries.map((entry) => entry.header.time.toISOString()),
      ["2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z"],
    );

    await normalizeBrowserArchive(path);
    assert.deepEqual(await readFile(path), first);
  });
});
