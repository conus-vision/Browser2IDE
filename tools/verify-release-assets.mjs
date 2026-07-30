import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertReleaseAssets,
  assertUnsignedReleaseAssets,
} from "./release-publishing.mjs";

const [phase, releasePath, version, checksumPath, ...extra] = process.argv.slice(2);
if (
  !["signed", "unsigned"].includes(phase) ||
  !releasePath ||
  !version ||
  !checksumPath ||
  extra.length > 0
) {
  throw new Error(
    "Usage: verify-release-assets <signed|unsigned> <release.json> <version> <SHA256SUMS>",
  );
}
const release = JSON.parse(await readFile(resolve(releasePath), "utf8"));
const checksums = await readFile(resolve(checksumPath), "utf8");
const verify = phase === "signed" ? assertReleaseAssets : assertUnsignedReleaseAssets;
verify(release, version, checksums);
process.stdout.write(`Draft release ${version} contains the exact ${phase} asset set\n`);
