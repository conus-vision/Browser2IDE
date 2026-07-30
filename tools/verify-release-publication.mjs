import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertPublicationRelease } from "./release-publishing.mjs";

const [state, releasePath, version, expectedDatabaseId, expectedTag, expectedTarget] =
  process.argv.slice(2);
if (
  !["draft", "published"].includes(state) ||
  !releasePath ||
  !version ||
  !expectedDatabaseId ||
  !expectedTag ||
  !expectedTarget
) {
  throw new Error(
    "Usage: verify-release-publication <draft|published> <release.json> <version> " +
      "<release-database-id> <tag> <target>",
  );
}

const release = JSON.parse(await readFile(resolve(releasePath), "utf8"));
const fingerprint = assertPublicationRelease(release, version, {
  expectedDatabaseId,
  expectedTag,
  expectedTarget,
  expectedDraft: state === "draft",
});
process.stdout.write(`${JSON.stringify(fingerprint)}\n`);
