import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReleaseAssets,
  parseChecksumManifest,
} from "../release-publishing.mjs";

const version = "0.2.0";
const unsignedName = `browser2ide-firefox-${version}.zip`;
const signedName = `browser2ide-firefox-${version}.xpi`;
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
