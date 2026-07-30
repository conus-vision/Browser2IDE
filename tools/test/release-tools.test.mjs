import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("artifact verifier rejects a directory missing required release artifacts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "browser2ide-verify-"));
  try {
    const result = runTool("verify-artifacts.mjs", directory);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Missing required release artifacts: .*browser2ide-vscode-0\.2\.0\.vsix/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checksum writer hashes sorted regular top-level artifact files", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "browser2ide-checksums-"));
  try {
    await writeFile(resolve(directory, "z.zip"), "zipped\n");
    await writeFile(resolve(directory, "a.vsix"), "vsix\n");
    await writeFile(resolve(directory, "SHA256SUMS"), "stale\n");
    await mkdir(resolve(directory, "nested"));
    await writeFile(resolve(directory, "nested", "ignored.zip"), "ignored\n");

    const result = runTool("write-checksums.mjs", directory);

    assert.equal(result.status, 0, result.stderr);
    const actual = await readFile(resolve(directory, "SHA256SUMS"), "utf8");
    const expected = [
      `${sha256("vsix\n")}  a.vsix`,
      `${sha256("zipped\n")}  z.zip`,
      "",
    ].join("\n");
    assert.equal(actual, expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runTool(name, ...arguments_) {
  return spawnSync(process.execPath, [resolve(repositoryRoot, "tools", name), ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
