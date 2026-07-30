import { verifyPublicationChecksumDirectory } from "./release-publishing.mjs";

const [directory, version] = process.argv.slice(2);
if (!directory || !version) {
  throw new Error(
    "Usage: verify-publication-checksums <release-directory> <version>",
  );
}

const fingerprint = await verifyPublicationChecksumDirectory(directory, version);
process.stdout.write(`${JSON.stringify(fingerprint)}\n`);
