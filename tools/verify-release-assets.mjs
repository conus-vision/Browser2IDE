import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertReleaseAssets,
  assertUnsignedReleaseAssets,
  compareReleaseArtifactDirectories,
} from "./release-publishing.mjs";

const [phase, releasePath, version, checksumPath, ...options] = process.argv.slice(2);
if (
  !["signed", "unsigned"].includes(phase) ||
  !releasePath ||
  !version ||
  !checksumPath
) {
  usage();
}
const parsedOptions = parseOptions(options);
const resolvedChecksumPath = resolve(checksumPath);
const release = JSON.parse(await readFile(resolve(releasePath), "utf8"));
const checksums = await readFile(resolvedChecksumPath, "utf8");
const verify = phase === "signed" ? assertReleaseAssets : assertUnsignedReleaseAssets;
const databaseId = verify(
  release,
  version,
  checksums,
  parsedOptions.expectedDatabaseId,
);
if (parsedOptions.compareDirectory) {
  await compareReleaseArtifactDirectories(
    phase,
    version,
    dirname(resolvedChecksumPath),
    parsedOptions.compareDirectory,
    parsedOptions.compareScope,
  );
}
process.stdout.write(`${databaseId}\n`);

function parseOptions(arguments_) {
  const result = {
    expectedDatabaseId: undefined,
    compareDirectory: undefined,
    compareScope: undefined,
  };
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!value) usage();
    if (option === "--expected-database-id" && result.expectedDatabaseId === undefined) {
      result.expectedDatabaseId = value;
    } else if (option === "--compare-all" && result.compareDirectory === undefined) {
      result.compareDirectory = resolve(value);
      result.compareScope = "all";
    } else if (
      option === "--compare-unsigned-artifacts" &&
      result.compareDirectory === undefined
    ) {
      result.compareDirectory = resolve(value);
      result.compareScope = "unsigned-artifacts";
    } else {
      usage();
    }
  }
  return result;
}

function usage() {
  throw new Error(
    "Usage: verify-release-assets <signed|unsigned> <release.json> <version> <SHA256SUMS> " +
      "[--expected-database-id ID] [--compare-all DIRECTORY|--compare-unsigned-artifacts DIRECTORY]",
  );
}
