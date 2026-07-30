import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertReleaseAssets } from "./release-publishing.mjs";

const [releasePath, version, checksumPath] = process.argv.slice(2);
if (!releasePath || !version || !checksumPath) {
  throw new Error("Usage: verify-release-assets <release.json> <version> <SHA256SUMS>");
}
const release = JSON.parse(await readFile(resolve(releasePath), "utf8"));
const checksums = await readFile(resolve(checksumPath), "utf8");
assertReleaseAssets(release, version, checksums);
process.stdout.write(`Draft release ${version} contains the exact signed asset set\n`);
