import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertAsciiFilename, compareAscii } from "./release-policy.mjs";

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

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

export function assertReleaseAssets(release, version, checksumSource, expectedDatabaseId) {
  return assertDraftReleaseAssets(
    release,
    version,
    checksumSource,
    true,
    expectedDatabaseId,
  );
}

export function assertUnsignedReleaseAssets(
  release,
  version,
  checksumSource,
  expectedDatabaseId,
) {
  return assertDraftReleaseAssets(
    release,
    version,
    checksumSource,
    false,
    expectedDatabaseId,
  );
}

export async function compareReleaseArtifactDirectories(
  phase,
  version,
  releaseDirectory,
  rebuildDirectory,
  scope = "all",
) {
  const includeSignedXpi = phase === "signed";
  if (!includeSignedXpi && phase !== "unsigned") {
    throw new Error(`Invalid release comparison phase: ${phase}`);
  }
  if (!["all", "unsigned-artifacts"].includes(scope)) {
    throw new Error(`Invalid release comparison scope: ${scope}`);
  }

  let names = expectedReleaseAssetNames(version, includeSignedXpi);
  if (scope === "unsigned-artifacts") {
    names = names.filter((name) => name !== "SHA256SUMS" && !name.endsWith(".xpi"));
  }
  for (const name of names) {
    const releasePath = resolve(releaseDirectory, name);
    const rebuildPath = resolve(rebuildDirectory, name);
    await assertRegularFile(releasePath, `release ${name}`);
    await assertRegularFile(rebuildPath, `rebuilt ${name}`);
    const [releaseBytes, rebuildBytes] = await Promise.all([
      readFile(releasePath),
      readFile(rebuildPath),
    ]);
    if (!releaseBytes.equals(rebuildBytes)) {
      throw new Error(`${name} differs between release and rebuild`);
    }
  }
}

function assertDraftReleaseAssets(
  release,
  version,
  checksumSource,
  includeSignedXpi,
  expectedDatabaseId,
) {
  if (release?.isDraft !== true) {
    throw new Error("Firefox signing release must still be a draft");
  }
  const databaseId = parseReleaseDatabaseId(release.databaseId);
  if (
    expectedDatabaseId !== undefined &&
    databaseId !== parseReleaseDatabaseId(expectedDatabaseId)
  ) {
    throw new Error(
      `Release database id differs: expected ${expectedDatabaseId}, received ${databaseId}`,
    );
  }
  const expected = expectedReleaseAssetNames(version, includeSignedXpi);
  if (!Array.isArray(release.assets)) {
    throw new Error("Release assets must be an array");
  }
  const actual = release.assets.map(({ name } = {}) => name).sort(compareAscii);
  if (actual.some((name) => typeof name !== "string")) {
    throw new Error("Release assets contain an invalid name");
  }
  const phase = includeSignedXpi ? "signed" : "unsigned";
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${phase} draft asset set differs: ${actual.join(", ")}`);
  }
  const checksumNames = [...parseChecksumManifest(checksumSource).keys()].sort(compareAscii);
  const expectedChecksums = expected.filter((name) => name !== "SHA256SUMS");
  if (JSON.stringify(checksumNames) !== JSON.stringify(expectedChecksums)) {
    throw new Error(`${phase} checksum asset set differs: ${checksumNames.join(", ")}`);
  }
  return databaseId;
}

function expectedReleaseAssetNames(version, includeSignedXpi) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Release version must match X.Y.Z, received ${version}`);
  }
  return [
    "SHA256SUMS",
    `browser2ide-chrome-${version}.zip`,
    `browser2ide-firefox-${version}.zip`,
    `browser2ide-firefox-source-${version}.zip`,
    `browser2ide-vscode-${version}.vsix`,
    ...(includeSignedXpi ? [`browser2ide-firefox-${version}.xpi`] : []),
  ].sort(compareAscii);
}

function parseReleaseDatabaseId(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Release database id must be a positive safe integer");
    }
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return value;
  }
  throw new Error("Release database id must be a positive integer");
}

async function assertRegularFile(path, label) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new Error(`Missing ${label}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
}
