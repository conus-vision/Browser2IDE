import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertReleaseAssets,
  assertUnsignedReleaseAssets,
  parseChecksumManifest,
} from "../release-publishing.mjs";

const version = "0.2.0";
const unsignedName = `browser2ide-firefox-${version}.zip`;
const signedName = `browser2ide-firefox-${version}.xpi`;
const unsignedNames = [
  `browser2ide-chrome-${version}.zip`,
  unsignedName,
  `browser2ide-firefox-source-${version}.zip`,
  `browser2ide-vscode-${version}.vsix`,
  "SHA256SUMS",
];
const original = [
  `${"1".repeat(64)}  browser2ide-chrome-${version}.zip`,
  `${"2".repeat(64)}  ${unsignedName}`,
  `${"3".repeat(64)}  browser2ide-firefox-source-${version}.zip`,
  `${"4".repeat(64)}  browser2ide-vscode-${version}.vsix`,
  "",
].join("\n");

test("checksum manifests reject malformed and duplicate entries", () => {
  assert.throws(() => parseChecksumManifest("not a checksum\n"), /Invalid checksum line/);
  assert.throws(
    () => parseChecksumManifest(`${original}${"9".repeat(64)}  ${unsignedName}\n`),
    /duplicate checksum filename/,
  );
});

test("draft release must contain signed and unsigned Firefox artifacts with checksums", () => {
  const names = [
    `browser2ide-chrome-${version}.zip`,
    unsignedName,
    signedName,
    `browser2ide-firefox-source-${version}.zip`,
    `browser2ide-vscode-${version}.vsix`,
    "SHA256SUMS",
  ];
  const checksums = original.replace(
    /\n$/,
    `\n${"5".repeat(64)}  ${signedName}\n`,
  );

  assert.doesNotThrow(() =>
    assertReleaseAssets(
      { isDraft: true, assets: names.map((name) => ({ name })) },
      version,
      checksums,
    ),
  );
  assert.throws(
    () =>
      assertReleaseAssets(
        { isDraft: false, assets: names.map((name) => ({ name })) },
        version,
        checksums,
      ),
    /must still be a draft/,
  );
  assert.throws(
    () =>
      assertReleaseAssets(
        { isDraft: true, assets: [...names, "unexpected.zip"].map((name) => ({ name })) },
        version,
        checksums,
      ),
    /asset set differs/,
  );
});

test("unsigned recovery phase accepts only the original five-asset draft", () => {
  assert.doesNotThrow(() =>
    assertUnsignedReleaseAssets(
      { isDraft: true, assets: unsignedNames.map((name) => ({ name })) },
      version,
      original,
    ),
  );
  assert.throws(
    () =>
      assertUnsignedReleaseAssets(
        { isDraft: false, assets: unsignedNames.map((name) => ({ name })) },
        version,
        original,
      ),
    /must still be a draft/,
  );
  assert.throws(
    () =>
      assertUnsignedReleaseAssets(
        { isDraft: true, assets: [...unsignedNames, signedName].map((name) => ({ name })) },
        version,
        original,
      ),
    /unsigned draft asset set differs/,
  );
  assert.throws(
    () =>
      assertUnsignedReleaseAssets(
        { isDraft: true, assets: unsignedNames.map((name) => ({ name })) },
        version,
        original.replace(/\n$/, `\n${"5".repeat(64)}  ${signedName}\n`),
      ),
    /unsigned checksum asset set differs/,
  );
});

test("release asset verifier CLI requires an explicit unsigned phase", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "browser2ide-unsigned-release-"));
  try {
    const releasePath = resolve(directory, "release.json");
    const checksumPath = resolve(directory, "SHA256SUMS");
    await writeFile(
      releasePath,
      JSON.stringify({ isDraft: true, assets: unsignedNames.map((name) => ({ name })) }),
    );
    await writeFile(checksumPath, original);

    const valid = runVerifier("unsigned", releasePath, version, checksumPath);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /exact unsigned asset set/);

    const wrongPhase = runVerifier("signed", releasePath, version, checksumPath);
    assert.notEqual(wrongPhase.status, 0);

    const missingPhase = runVerifier(releasePath, version, checksumPath);
    assert.notEqual(missingPhase.status, 0);
    assert.match(missingPhase.stderr, /Usage:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runVerifier(...arguments_) {
  return spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "../verify-release-assets.mjs"), ...arguments_],
    { encoding: "utf8" },
  );
}
