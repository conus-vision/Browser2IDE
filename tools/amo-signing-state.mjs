import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseTag } from "./verify-release-version.mjs";

const STATE_KEYS = ["channel", "uploadUuid", "xpiCrcHash"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CRC_PATTERN = /^[0-9a-f]{64}$/;

export function createAmoStateArtifactName(tag, runId) {
  parseReleaseTag(tag);
  if (!/^[1-9]\d*$/.test(runId)) {
    throw new Error("GitHub run id must be a positive integer");
  }
  return `browser2ide-amo-state-${tag}-run-${runId}`;
}

export function parseAmoUploadState(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Invalid AMO upload state");
  }

  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (
    JSON.stringify(keys) !== JSON.stringify(STATE_KEYS) ||
    !UUID_PATTERN.test(value.uploadUuid) ||
    value.channel !== "unlisted" ||
    !CRC_PATTERN.test(value.xpiCrcHash)
  ) {
    throw new Error("Invalid AMO upload state");
  }

  return {
    uploadUuid: value.uploadUuid,
    channel: value.channel,
    xpiCrcHash: value.xpiCrcHash,
  };
}

export async function preserveAmoUploadState(sourcePath, destinationPath) {
  let source;
  try {
    source = await readFile(resolve(sourcePath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  const state = parseAmoUploadState(source);
  const destination = resolve(destinationPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return true;
}

async function runCli() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "artifact-name" && arguments_.length === 2) {
    process.stdout.write(`${createAmoStateArtifactName(arguments_[0], arguments_[1])}\n`);
    return;
  }
  if (command === "validate" && arguments_.length === 1) {
    parseAmoUploadState(await readFile(resolve(arguments_[0]), "utf8"));
    process.stdout.write("AMO upload state is valid\n");
    return;
  }
  if (command === "preserve" && arguments_.length === 2) {
    const preserved = await preserveAmoUploadState(arguments_[0], arguments_[1]);
    process.stdout.write(preserved ? "AMO upload state prepared\n" : "No AMO upload state was created\n");
    return;
  }
  throw new Error(
    "Usage: amo-signing-state <artifact-name TAG RUN_ID|validate PATH|preserve SOURCE DESTINATION>",
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
