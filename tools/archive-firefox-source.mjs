import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(
  repositoryRoot,
  "artifacts/browser2ide-firefox-source-0.2.0.zip",
);

export function archiveArguments(root, output) {
  const portableRoot = portablePath(root);
  return [
    "-c",
    `safe.directory=${portableRoot}`,
    "archive",
    "--format=zip",
    `--output=${portablePath(output)}`,
    "HEAD",
  ];
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = spawnSync(
    "git",
    archiveArguments(repositoryRoot, outputPath),
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function portablePath(path) {
  return resolve(path).replaceAll("\\", "/");
}
