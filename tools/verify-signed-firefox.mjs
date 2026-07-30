import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readArchive } from "./verify-artifacts.mjs";

const SIGNING_ENTRIES = [
  "META-INF/cose.manifest",
  "META-INF/cose.sig",
  "META-INF/manifest.mf",
  "META-INF/mozilla.rsa",
  "META-INF/mozilla.sf",
];
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export function verifySignedFirefoxXpi(
  unsignedPath,
  signedPath,
  expectedVersion,
  expectedGeckoId,
) {
  if (!VERSION_PATTERN.test(expectedVersion)) {
    throw new Error(`Expected manifest version must match X.Y.Z: ${expectedVersion}`);
  }
  if (
    typeof expectedGeckoId !== "string" ||
    expectedGeckoId.length === 0 ||
    expectedGeckoId.length > 255 ||
    /[\x00-\x20\x7f]/.test(expectedGeckoId)
  ) {
    throw new Error("Expected Gecko ID is invalid");
  }

  const unsignedName = "unsigned Firefox ZIP";
  const signedName = "signed Firefox XPI";
  const unsigned = readArchive(resolve(unsignedPath), unsignedName);
  const signed = readArchive(resolve(signedPath), signedName);
  const unsignedManifest = readManifest(unsigned, unsignedName);
  const signedManifest = readManifest(signed, signedName);
  assertManifestIdentity(unsignedManifest, unsignedName, expectedVersion, expectedGeckoId);
  assertManifestIdentity(signedManifest, signedName, expectedVersion, expectedGeckoId);

  for (const path of unsigned.paths) {
    if (path === "META-INF" || path.startsWith("META-INF/")) {
      throw new Error(`${unsignedName} must not contain signing entry ${path}`);
    }
  }

  for (const [path, bytes] of unsigned.files) {
    const signedBytes = signed.files.get(path);
    if (!signedBytes) {
      throw new Error(`${signedName} is missing runtime entry ${path}`);
    }
    if (!signedBytes.equals(bytes)) {
      throw new Error(`${signedName} runtime entry differs: ${path}`);
    }
  }

  const signingSet = new Set(SIGNING_ENTRIES);
  for (const path of signed.files.keys()) {
    if (!unsigned.files.has(path) && !signingSet.has(path)) {
      throw new Error(`${signedName} contains unexpected signed XPI entry ${path}`);
    }
  }
  for (const path of SIGNING_ENTRIES) {
    const bytes = signed.files.get(path);
    if (!bytes || bytes.length === 0) {
      throw new Error(`${signedName} is missing signing entry ${path}`);
    }
  }

  const allowedPaths = collectAllowedPaths([
    ...unsigned.files.keys(),
    ...SIGNING_ENTRIES,
  ]);
  for (const path of signed.paths) {
    if (!allowedPaths.has(path)) {
      throw new Error(`${signedName} contains unexpected signed XPI entry ${path}`);
    }
  }
}

function readManifest(archive, filename) {
  const bytes = archive.files.get("manifest.json");
  if (!bytes) throw new Error(`${filename} is missing manifest.json`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${filename} contains invalid manifest.json: ${error.message}`);
  }
}

function assertManifestIdentity(manifest, filename, expectedVersion, expectedGeckoId) {
  if (manifest?.version !== expectedVersion) {
    throw new Error(`${filename} manifest version must be ${expectedVersion}`);
  }
  if (manifest?.browser_specific_settings?.gecko?.id !== expectedGeckoId) {
    throw new Error(`${filename} Gecko ID must be ${expectedGeckoId}`);
  }
}

function collectAllowedPaths(files) {
  const paths = new Set();
  for (const file of files) {
    paths.add(file);
    const segments = file.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      paths.add(segments.slice(0, index).join("/"));
    }
  }
  return paths;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [unsignedPath, signedPath, version, geckoId, ...extra] = process.argv.slice(2);
  if (!unsignedPath || !signedPath || !version || !geckoId || extra.length > 0) {
    throw new Error(
      "Usage: verify-signed-firefox <unsigned-firefox.zip> <signed-firefox.xpi> <version> <gecko-id>",
    );
  }
  verifySignedFirefoxXpi(unsignedPath, signedPath, version, geckoId);
  process.stdout.write(`Verified signed Firefox XPI ${version}\n`);
}
