import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAsciiFilename,
  assertVersion,
  normalizeArchivePath,
  rejectSensitivePath,
} from "../release-policy.mjs";

test("archive paths reject traversal and absolute forms", () => {
  for (const path of [
    "../secret.txt",
    "dist/../../secret.txt",
    "dist\\..\\secret.txt",
    "/absolute.txt",
    "C:\\absolute.txt",
  ]) {
    assert.throws(
      () => normalizeArchivePath(path, "fixture.zip", false),
      /dangerous archive path/,
    );
  }
  assert.equal(
    normalizeArchivePath("dist/panel.js", "fixture.zip", false),
    "dist/panel.js",
  );
});

test("release archives reject sensitive path segments", () => {
  for (const path of [
    ".env",
    "config/.env.production",
    "node_modules/package/index.js",
    ".vscode-test/vscode.exe",
    "private/secret.json",
    "private/credentials.yml",
  ]) {
    assert.throws(
      () => rejectSensitivePath(path, "fixture.zip"),
      /forbidden path/,
    );
  }
  assert.doesNotThrow(() => rejectSensitivePath("src/secretary.ts", "fixture.zip"));
});

test("release versions must match the expected product version", () => {
  assert.doesNotThrow(() => assertVersion("0.2.0", "manifest", "0.2.0"));
  assert.throws(
    () => assertVersion("0.1.0", "manifest", "0.2.0"),
    /manifest version must be 0\.2\.0, received 0\.1\.0/,
  );
});

test("checksum artifact names must be printable ASCII", () => {
  assert.doesNotThrow(() => assertAsciiFilename("browser2ide-firefox-0.2.0.zip"));
  assert.throws(() => assertAsciiFilename("bröwser.zip"), /printable ASCII/);
  assert.throws(() => assertAsciiFilename("line\nbreak.zip"), /printable ASCII/);
});
