import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  parseReleaseTag,
  verifyReleaseVersion,
} from "../verify-release-version.mjs";

test("release tags must use the exact vX.Y.Z format", () => {
  assert.equal(parseReleaseTag("v0.2.0"), "0.2.0");
  assert.equal(parseReleaseTag("v12.34.56"), "12.34.56");

  for (const tag of [
    "0.2.0",
    "v01.2.0",
    "v1.02.0",
    "v1.2.03",
    "v1.2",
    "v1.2.3-beta.1",
    "v1.2.3\nunsafe",
  ]) {
    assert.throws(() => parseReleaseTag(tag), /must match vX\.Y\.Z/);
  }
});

test("release version verifier accepts aligned package and manifest versions", async () => {
  const fixture = await createVersionFixture("0.2.0");
  try {
    const result = await verifyReleaseVersion(fixture, "v0.2.0");

    assert.equal(result.version, "0.2.0");
    assert.deepEqual(result.versions, {
      root: "0.2.0",
      vscodePackage: "0.2.0",
      firefoxPackage: "0.2.0",
      firefoxManifest: "0.2.0",
      chromePackage: "0.2.0",
      chromeManifest: "0.2.0",
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release version verifier rejects every mismatched product version", async () => {
  const fixture = await createVersionFixture("0.2.0");
  try {
    await writeJson(resolve(fixture, "extensions/chrome/manifest.json"), {
      version: "0.2.1",
    });

    await assert.rejects(
      () => verifyReleaseVersion(fixture, "v0.2.0"),
      /Chrome manifest version must be 0\.2\.0, received 0\.2\.1/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function createVersionFixture(version) {
  const root = await mkdtemp(resolve(tmpdir(), "browser2ide-version-"));
  const files = [
    "package.json",
    "extensions/vscode/package.json",
    "extensions/firefox/package.json",
    "extensions/firefox/manifest.json",
    "extensions/chrome/package.json",
    "extensions/chrome/manifest.json",
  ];

  for (const file of files) {
    await writeJson(resolve(root, file), { version });
  }
  return root;
}

async function writeJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
