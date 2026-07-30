import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createAmoStateArtifactName,
  parseAmoUploadState,
} from "../amo-signing-state.mjs";

const validState = {
  uploadUuid: "123e4567-e89b-42d3-a456-426614174000",
  channel: "unlisted",
  xpiCrcHash: "a".repeat(64),
};

test("AMO state artifact names use only a validated tag and positive run id", () => {
  assert.equal(
    createAmoStateArtifactName("v0.2.0", "123456789"),
    "browser2ide-amo-state-v0.2.0-run-123456789",
  );

  for (const runId of ["", "0", "01", "-1", "1.5", "12x", " 12", "12\n"] ) {
    assert.throws(
      () => createAmoStateArtifactName("v0.2.0", runId),
      /run id must be a positive integer/,
    );
  }
  assert.throws(
    () => createAmoStateArtifactName("v0.2.0;echo unsafe", "12"),
    /must match vX\.Y\.Z/,
  );
});

test("AMO upload state accepts UUID, channel and CRC only", () => {
  assert.deepEqual(parseAmoUploadState(JSON.stringify(validState)), validState);

  for (const invalid of [
    { ...validState, apiSecret: "must-not-be-uploaded" },
    { ...validState, uploadUuid: "not-a-uuid" },
    { ...validState, channel: "listed" },
    { ...validState, xpiCrcHash: "a".repeat(63) },
  ]) {
    assert.throws(() => parseAmoUploadState(JSON.stringify(invalid)), /Invalid AMO upload state/);
  }
});

test("preserve command writes a canonical hidden state file without extra fields", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "browser2ide-amo-state-"));
  try {
    const source = resolve(directory, "source.json");
    const destination = resolve(directory, "artifact", ".amo-upload-uuid");
    await writeFile(source, JSON.stringify(validState));

    const result = runTool("preserve", source, destination);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(destination, "utf8"),
      `${JSON.stringify(validState)}\n`,
    );
    assert.doesNotMatch(result.stdout, /123e4567|a{16}/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserve command does not emit an artifact for missing or unsafe state", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "browser2ide-amo-state-"));
  try {
    const missingDestination = resolve(directory, "missing", ".amo-upload-uuid");
    const missing = runTool("preserve", resolve(directory, "absent"), missingDestination);
    assert.equal(missing.status, 0, missing.stderr);
    await assert.rejects(() => readFile(missingDestination), /ENOENT/);

    const unsafeSource = resolve(directory, "unsafe.json");
    const unsafeDestination = resolve(directory, "unsafe", ".amo-upload-uuid");
    await writeFile(
      unsafeSource,
      JSON.stringify({ ...validState, apiKey: "must-not-be-uploaded" }),
    );
    const unsafe = runTool("preserve", unsafeSource, unsafeDestination);
    assert.notEqual(unsafe.status, 0);
    await assert.rejects(() => readFile(unsafeDestination), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runTool(...arguments_) {
  return spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "../amo-signing-state.mjs"), ...arguments_],
    { encoding: "utf8" },
  );
}
