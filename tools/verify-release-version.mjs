import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_FILES = [
  ["package.json", "root package", "root"],
  ["extensions/vscode/package.json", "VS Code package", "vscodePackage"],
  ["extensions/firefox/package.json", "Firefox package", "firefoxPackage"],
  ["extensions/firefox/manifest.json", "Firefox manifest", "firefoxManifest"],
  ["extensions/chrome/package.json", "Chrome package", "chromePackage"],
  ["extensions/chrome/manifest.json", "Chrome manifest", "chromeManifest"],
];

export function parseReleaseTag(tag) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
    throw new Error(`Release tag must match vX.Y.Z, received ${tag || "<empty>"}`);
  }
  return tag.slice(1);
}

export async function verifyReleaseVersion(root, tag) {
  const version = parseReleaseTag(tag);
  const versions = {};

  for (const [path, label, key] of VERSION_FILES) {
    const value = JSON.parse(await readFile(resolve(root, path), "utf8"));
    versions[key] = value.version;
    if (value.version !== version) {
      throw new Error(
        `${label} version must be ${version}, received ${String(value.version)}`,
      );
    }
  }

  return { version, versions };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, "..");
  const { version } = await verifyReleaseVersion(root, process.argv[2] ?? "");
  process.stdout.write(`${version}\n`);
}
