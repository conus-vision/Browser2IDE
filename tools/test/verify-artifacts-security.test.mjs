import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import AdmZip from "adm-zip";
import { withTemporaryDirectory } from "./test-helpers.mjs";
import { createHeadArchiveBuffer } from "../archive-firefox-source.mjs";
import {
  assertExactArchivePaths,
  readArchive,
  readHeadTree,
  verifySourceArchiveIdentity,
  verifySourceAgainstHead,
} from "../verify-artifacts.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("runtime allowlists reject every additional entry", async () => {
  await withTemporaryDirectory("browser2ide-extra-", async (directory) => {
    const path = resolve(directory, "runtime.zip");
    writeZip(path, [
      ["manifest.json", "{}"],
      ["dist/panel.js", "runtime"],
      ["extra.txt", "unexpected"],
    ]);

    const archive = readArchive(path, "runtime.zip");
    assert.throws(
      () => assertExactArchivePaths(
        archive,
        "runtime.zip",
        ["manifest.json", "dist/panel.js"],
      ),
      /unexpected archive path extra\.txt/,
    );
  });
});

test("archive reader rejects credential paths", async () => {
  await withTemporaryDirectory("browser2ide-credential-", async (directory) => {
    const path = resolve(directory, "credential.zip");
    writeZip(path, [["config/private.pem", "private key material"]]);

    assert.throws(
      () => readArchive(path, "credential.zip"),
      /forbidden path config\/private\.pem/,
    );
  });
});

test("archive reader rejects traversal and absolute entry names", async () => {
  await withTemporaryDirectory("browser2ide-path-", async (directory) => {
    const traversalPath = resolve(directory, "traversal.zip");
    const traversal = new AdmZip();
    traversal.addFile("xx/evil.txt", Buffer.from("bad"));
    await writeFile(
      traversalPath,
      replaceZipEntryName(traversal.toBuffer(), "xx/evil.txt", "../evil.txt"),
    );
    assert.throws(
      () => readArchive(traversalPath, "traversal.zip"),
      /dangerous archive path \.\.\/evil\.txt/,
    );

    const absolutePath = resolve(directory, "absolute.zip");
    writeZip(absolutePath, [["C:/private.key", "bad"]]);
    assert.throws(
      () => readArchive(absolutePath, "absolute.zip"),
      /dangerous archive path C:\/private\.key/,
    );
  });
});

test("archive reader rejects case-insensitive path collisions", async () => {
  await withTemporaryDirectory("browser2ide-case-", async (directory) => {
    const path = resolve(directory, "case.zip");
    writeZip(path, [["LICENSE", "one"], ["license", "two"]]);

    assert.throws(
      () => readArchive(path, "case.zip"),
      /case-insensitive path collision: LICENSE and license/,
    );
  });
});

test("archive reader rejects ZIP entries marked as symbolic links", async () => {
  await withTemporaryDirectory("browser2ide-symlink-", async (directory) => {
    const path = resolve(directory, "symlink.zip");
    const zip = new AdmZip();
    zip.addFile("link", Buffer.from("target"));
    const entry = zip.getEntry("link");
    entry.attr = (0o120777 << 16) >>> 0;
    entry.header.made = (3 << 8) | 20;
    zip.writeZip(path);

    assert.throws(
      () => readArchive(path, "symlink.zip"),
      /symbolic link entry link/,
    );
  });
});

test("source verification rejects omissions additions and changed blobs", async () => {
  const expectedContent = Buffer.from("expected\n");
  const head = new Map([
    ["tracked.txt", { mode: "100644", type: "blob", object: "abc123" }],
  ]);
  const readBlob = async () => expectedContent;

  await withTemporaryDirectory("browser2ide-source-", async (directory) => {
    const omissionPath = resolve(directory, "omission.zip");
    writeZip(omissionPath, []);
    await assert.rejects(
      verifySourceAgainstHead(
        readArchive(omissionPath, "omission.zip"),
        "omission.zip",
        head,
        readBlob,
      ),
      /missing archive path tracked\.txt/,
    );

    const additionPath = resolve(directory, "addition.zip");
    writeZip(additionPath, [["tracked.txt", expectedContent], ["extra.txt", "x"]]);
    await assert.rejects(
      verifySourceAgainstHead(
        readArchive(additionPath, "addition.zip"),
        "addition.zip",
        head,
        readBlob,
      ),
      /unexpected archive path extra\.txt/,
    );

    const changedPath = resolve(directory, "changed.zip");
    writeZip(changedPath, [["tracked.txt", "changed\n"]]);
    await assert.rejects(
      verifySourceAgainstHead(
        readArchive(changedPath, "changed.zip"),
        "changed.zip",
        head,
        readBlob,
      ),
      /differs from HEAD blob tracked\.txt/,
    );
  });
});

test("source verification rejects symlink submodule and unsupported HEAD modes", async () => {
  const archive = { files: new Map(), paths: [] };
  for (const [mode, type] of [
    ["120000", "blob"],
    ["160000", "commit"],
    ["100600", "blob"],
  ]) {
    const head = new Map([
      ["unsupported", { mode, type, object: "abc123" }],
    ]);
    await assert.rejects(
      verifySourceAgainstHead(archive, "source.zip", head, async () => Buffer.alloc(0)),
      /unsupported HEAD entry mode/,
    );
  }
});

test("source verification matches a real git archive of the linked worktree HEAD", async () => {
  await withTemporaryDirectory("browser2ide-head-", async (directory) => {
    const archivePath = resolve(directory, "head.zip");
    await writeFile(archivePath, createHeadArchiveBuffer(repositoryRoot));

    const head = readHeadTree(repositoryRoot);
    const archive = readArchive(archivePath, "head.zip");
    await verifySourceAgainstHead(
      archive,
      "head.zip",
      head,
    );
    verifySourceArchiveIdentity(archive, "head.zip", repositoryRoot);
    assert.ok(head.size > 100);
  });
});

test("source identity rejects an executable-mode-only ZIP metadata change", async () => {
  await withTemporaryDirectory("browser2ide-mode-", async (directory) => {
    const originalPath = resolve(directory, "original.zip");
    const changedPath = resolve(directory, "changed.zip");
    const original = createHeadArchiveBuffer(repositoryRoot);
    const changed = changeCentralDirectoryMode(original, "README.md", 0o100755);
    await writeFile(originalPath, original);
    await writeFile(changedPath, changed);

    const originalArchive = readArchive(originalPath, "original.zip");
    const changedArchive = readArchive(changedPath, "changed.zip");
    const head = readHeadTree(repositoryRoot);
    assert.equal(head.get("README.md")?.mode, "100644");
    assert.deepEqual(changedArchive.paths, originalArchive.paths);
    for (const [path, content] of originalArchive.files) {
      assert.ok(changedArchive.files.get(path).equals(content), path);
    }
    await verifySourceAgainstHead(
      changedArchive,
      "changed.zip",
      head,
      (_object, path) => originalArchive.files.get(path),
    );
    assert.throws(
      () => verifySourceArchiveIdentity(changedArchive, "changed.zip", repositoryRoot),
      /not byte-for-byte identical to git archive HEAD/,
    );
  });
});

function writeZip(path, entries) {
  const zip = new AdmZip();
  for (const [name, content] of entries) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  zip.writeZip(path);
}

function replaceZipEntryName(buffer, source, replacement) {
  assert.equal(Buffer.byteLength(source), Buffer.byteLength(replacement));
  const result = Buffer.from(buffer);
  const sourceBytes = Buffer.from(source);
  const replacementBytes = Buffer.from(replacement);
  let offset = 0;
  let replacements = 0;
  while ((offset = result.indexOf(sourceBytes, offset)) >= 0) {
    replacementBytes.copy(result, offset);
    offset += sourceBytes.length;
    replacements += 1;
  }
  assert.equal(replacements, 2);
  return result;
}

function changeCentralDirectoryMode(buffer, targetPath, mode) {
  const result = Buffer.from(buffer);
  const signature = 0x02014b50;
  for (let offset = 0; offset <= result.length - 46;) {
    if (result.readUInt32LE(offset) !== signature) {
      offset += 1;
      continue;
    }
    const filenameLength = result.readUInt16LE(offset + 28);
    const extraLength = result.readUInt16LE(offset + 30);
    const commentLength = result.readUInt16LE(offset + 32);
    const filename = result.subarray(offset + 46, offset + 46 + filenameLength).toString("utf8");
    if (filename === targetPath) {
      result.writeUInt16LE((3 << 8) | 20, offset + 4);
      result.writeUInt32LE((mode << 16) >>> 0, offset + 38);
      return result;
    }
    offset += 46 + filenameLength + extraLength + commentLength;
  }
  throw new Error(`Central directory entry not found: ${targetPath}`);
}
