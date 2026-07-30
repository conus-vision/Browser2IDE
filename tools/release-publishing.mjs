import { assertAsciiFilename, compareAscii } from "./release-policy.mjs";

export function parseChecksumManifest(source) {
  if (source.includes("\r")) {
    throw new Error("Checksum manifest must use LF line endings");
  }
  const entries = new Map();
  for (const line of source.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64})  ([\x20-\x7e]+)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid checksum line: ${line}`);
    }
    const [, hash, filename] = match;
    assertAsciiFilename(filename);
    if (filename.includes("/") || filename.includes("\\") || entries.has(filename)) {
      throw new Error(`Invalid or duplicate checksum filename: ${filename}`);
    }
    entries.set(filename, hash);
  }
  return entries;
}

export function assertReleaseAssets(release, version, checksumSource) {
  if (release?.isDraft !== true) {
    throw new Error("Firefox signing release must still be a draft");
  }
  const expected = [
    "SHA256SUMS",
    `browser2ide-chrome-${version}.zip`,
    `browser2ide-firefox-${version}.zip`,
    `browser2ide-firefox-${version}.xpi`,
    `browser2ide-firefox-source-${version}.zip`,
    `browser2ide-vscode-${version}.vsix`,
  ].sort(compareAscii);
  const actual = (release.assets ?? []).map(({ name }) => name).sort(compareAscii);
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Draft release asset set differs: ${actual.join(", ")}`);
  }
  const checksumNames = [...parseChecksumManifest(checksumSource).keys()].sort(compareAscii);
  const expectedChecksums = expected.filter((name) => name !== "SHA256SUMS");
  if (JSON.stringify(checksumNames) !== JSON.stringify(expectedChecksums)) {
    throw new Error(`Checksum asset set differs: ${checksumNames.join(", ")}`);
  }
}
