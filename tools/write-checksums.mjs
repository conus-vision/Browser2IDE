import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertAsciiFilename, compareAscii } from "./release-policy.mjs";

const artifactDirectory = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : undefined;

if (!artifactDirectory) {
  fail("Usage: node tools/write-checksums.mjs <artifact-directory>");
}

try {
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS")
    .map((entry) => entry.name)
    .sort(compareAscii);

  if (filenames.length === 0) {
    throw new Error(`No artifact files found in ${artifactDirectory}`);
  }
  for (const filename of filenames) assertAsciiFilename(filename);

  const lines = [];
  for (const filename of filenames) {
    const content = await readFile(resolve(artifactDirectory, filename));
    const digest = createHash("sha256").update(content).digest("hex");
    lines.push(`${digest}  ${filename}`);
  }
  await writeFile(
    resolve(artifactDirectory, "SHA256SUMS"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
