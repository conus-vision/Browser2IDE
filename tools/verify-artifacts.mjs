import { spawnSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import {
  assertTextEqual,
  assertVersion,
  compareAscii,
  normalizeArchivePath,
  rejectSensitivePath,
} from "./release-policy.mjs";

const VERSION = "0.2.0";
const EXPECTED_ARTIFACTS = new Map([
  [`browser2ide-vscode-${VERSION}.vsix`, "vscode"],
  [`browser2ide-chrome-${VERSION}.zip`, "chrome"],
  [`browser2ide-firefox-${VERSION}.zip`, "firefox"],
  [`browser2ide-firefox-source-${VERSION}.zip`, "firefox-source"],
]);
const BROWSER_ARCHIVE_FILES = [
  "LICENSE",
  "THIRD_PARTY_NOTICES",
  "manifest.json",
  "dist/background.js",
  "dist/browser2ide.svg",
  "dist/contentScript.js",
  "dist/devtools.html",
  "dist/devtools.js",
  "dist/panel.css",
  "dist/panel.html",
  "dist/panel.js",
];
const VSIX_ARCHIVE_FILES = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/THIRD_PARTY_NOTICES",
  "extension/dist/extension.cjs",
  "extension/dist/mappings.wasm",
  "extension/package.json",
  "extension/readme.md",
  "extension/resources/browser2ide.svg",
];
const REGULAR_GIT_MODES = new Set(["100644", "100755"]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectLicense = await readFile(resolve(repositoryRoot, "LICENSE"));

export async function verifyArtifacts(arguments_) {
  const artifacts = await collectArtifacts(arguments_);
  const missing = [...EXPECTED_ARTIFACTS.keys()].filter(
    (filename) => !artifacts.has(filename),
  );
  if (missing.length > 0) {
    throw new Error(`Missing required release artifacts: ${missing.join(", ")}`);
  }

  for (const [filename, kind] of EXPECTED_ARTIFACTS) {
    const archive = readArchive(artifacts.get(filename), filename);
    if (kind === "vscode") await verifyVsix(archive, filename);
    else if (kind === "firefox-source") await verifySource(archive, filename);
    else await verifyBrowser(archive, filename, kind);
    console.log(`Verified ${filename} (${archive.files.size} files)`);
  }
}

export function readArchive(path, filename) {
  let zip;
  try {
    zip = new AdmZip(path);
  } catch (error) {
    throw new Error(`${filename} is not a readable ZIP archive: ${error.message}`);
  }

  const files = new Map();
  const seen = new Set();
  const caseFolded = new Map();
  for (const entry of zip.getEntries()) {
    const name = normalizeArchivePath(entry.entryName, filename, entry.isDirectory);
    if (seen.has(name)) {
      throw new Error(`${filename} contains duplicate path ${name}`);
    }
    const folded = name.toLowerCase();
    const existing = caseFolded.get(folded);
    if (existing !== undefined && existing !== name) {
      throw new Error(
        `${filename} contains case-insensitive path collision: ${existing} and ${name}`,
      );
    }
    rejectZipSymlink(entry, name, filename);
    rejectSensitivePath(name, filename);
    seen.add(name);
    caseFolded.set(folded, name);
    if (!entry.isDirectory) files.set(name, entry.getData());
  }
  return { files, paths: [...seen].sort(compareAscii) };
}

export function assertExactArchivePaths(archive, filename, expectedPaths) {
  const expected = new Set(expectedPaths);
  for (const path of [...expected].sort(compareAscii)) {
    if (!archive.paths.includes(path)) {
      throw new Error(`${filename} is missing archive path ${path}`);
    }
  }
  for (const path of archive.paths) {
    if (!expected.has(path)) {
      throw new Error(`${filename} contains unexpected archive path ${path}`);
    }
  }
  if (archive.paths.length !== expected.size) {
    throw new Error(`${filename} archive path set is not exact`);
  }
}

export function readHeadTree(root = repositoryRoot) {
  const output = runGit(root, ["ls-tree", "-rz", "--full-tree", "HEAD"]);
  const tree = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const record of splitNullTerminated(output)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("git ls-tree returned a malformed record");
    const metadata = record.subarray(0, tab).toString("ascii");
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(metadata);
    if (!match) throw new Error(`git ls-tree returned malformed metadata: ${metadata}`);
    let path;
    try {
      path = decoder.decode(record.subarray(tab + 1));
    } catch {
      throw new Error("HEAD contains a path that is not valid UTF-8");
    }
    if (tree.has(path)) throw new Error(`HEAD contains duplicate path ${path}`);
    tree.set(path, { mode: match[1], type: match[2], object: match[3] });
  }
  return tree;
}

export async function verifySourceAgainstHead(
  archive,
  filename,
  head,
  blobReader,
) {
  const folded = new Map();
  for (const [path, entry] of head) {
    if (!REGULAR_GIT_MODES.has(entry.mode) || entry.type !== "blob") {
      throw new Error(
        `${filename} has unsupported HEAD entry mode ${entry.mode} (${entry.type}) at ${path}`,
      );
    }
    const key = path.toLowerCase();
    const existing = folded.get(key);
    if (existing !== undefined && existing !== path) {
      throw new Error(`HEAD contains case-insensitive path collision: ${existing} and ${path}`);
    }
    folded.set(key, path);
  }

  assertExactArchivePaths(archive, filename, expectedGitArchivePaths(head.keys()));
  const readBlob = blobReader ?? ((object) => readHeadBlob(repositoryRoot, object));
  for (const [path, entry] of head) {
    const expected = await readBlob(entry.object, path);
    const actual = archive.files.get(path);
    if (!Buffer.isBuffer(expected)) {
      throw new Error(`HEAD blob reader did not return a Buffer for ${path}`);
    }
    if (!actual?.equals(expected)) {
      throw new Error(`${filename} differs from HEAD blob ${path}`);
    }
  }
}

async function collectArtifacts(arguments_) {
  if (arguments_.length === 0) {
    throw new Error(
      "Usage: node tools/verify-artifacts.mjs <artifact-directory|artifact-path> [...]",
    );
  }

  const paths = new Map();
  for (const argument of arguments_) {
    const path = resolve(process.cwd(), argument);
    let stats;
    try {
      stats = await lstat(path);
    } catch {
      throw new Error(`Artifact path does not exist: ${path}`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Artifact path must not be a symbolic link: ${path}`);
    }
    if (stats.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name === "SHA256SUMS") continue;
        if (!entry.isFile()) {
          throw new Error(`Unexpected non-file artifact entry: ${entry.name}`);
        }
        addArtifact(paths, entry.name, resolve(path, entry.name));
      }
    } else if (stats.isFile()) {
      addArtifact(paths, filenameFromPath(path), path);
    } else {
      throw new Error(`Artifact path is not a regular file or directory: ${path}`);
    }
  }
  return paths;
}

function addArtifact(paths, filename, path) {
  if (!EXPECTED_ARTIFACTS.has(filename)) {
    throw new Error(`Unexpected release artifact: ${filename}`);
  }
  if (paths.has(filename)) {
    throw new Error(`Release artifact was provided more than once: ${filename}`);
  }
  paths.set(filename, path);
}

function filenameFromPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

async function verifyBrowser(archive, filename, browser) {
  assertExactArchivePaths(archive, filename, BROWSER_ARCHIVE_FILES);
  assertProjectLicense(archive, filename, "LICENSE");
  const noticePath = resolve(repositoryRoot, "extensions", browser, "THIRD_PARTY_NOTICES");
  assertEqualFile(
    archive,
    filename,
    "THIRD_PARTY_NOTICES",
    await readFile(noticePath),
  );

  verifyBrowserManifest(
    parseJsonFile(archive, filename, "manifest.json"),
    filename,
    browser,
  );
}

function verifyBrowserManifest(manifest, filename, browser) {
  if (manifest.manifest_version !== 3) {
    throw new Error(`${filename} has unexpected manifest_version`);
  }
  if (manifest.name !== "Browser2IDE") {
    throw new Error(`${filename} has unexpected manifest name`);
  }
  assertVersion(manifest.version, `${filename} manifest`, VERSION);
  if (!Array.isArray(manifest.host_permissions) || !manifest.host_permissions.includes("<all_urls>")) {
    throw new Error(`${filename} manifest must request <all_urls>`);
  }
  const forbiddenHosts = manifest.host_permissions.filter((value) =>
    typeof value === "string" && /^wss?:\/\//i.test(value)
  );
  if (forbiddenHosts.length > 0) {
    throw new Error(`${filename} has forbidden WebSocket host_permissions: ${forbiddenHosts.join(", ")}`);
  }
  if (browser === "chrome" && manifest.minimum_chrome_version !== "116") {
    throw new Error(`${filename} has unexpected minimum_chrome_version`);
  }
  if (
    browser === "firefox" &&
    manifest.browser_specific_settings?.gecko?.strict_min_version !== "142.0"
  ) {
    throw new Error(`${filename} has unexpected Firefox strict_min_version`);
  }
}

async function verifyVsix(archive, filename) {
  assertExactArchivePaths(archive, filename, VSIX_ARCHIVE_FILES);
  assertProjectLicense(archive, filename, "extension/LICENSE.txt");

  const manifest = parseJsonFile(archive, filename, "extension/package.json");
  if (manifest.name !== "browser2ide-vscode") {
    throw new Error(`${filename} has unexpected extension name`);
  }
  assertVersion(manifest.version, `${filename} extension`, VERSION);
  if (manifest.main !== "./dist/extension.cjs") {
    throw new Error(`${filename} has unexpected extension main: ${manifest.main}`);
  }

  const bundle = archive.files.get("extension/dist/extension.cjs").toString("utf8");
  const runtimeRequires = [
    ...bundle.matchAll(/\brequire\((["'])([^"'.\/][^"']*)\1\)/g),
  ].map((match) => match[2]);
  const builtins = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ]);
  const unsupported = [...new Set(runtimeRequires)]
    .filter((name) => name !== "vscode" && !builtins.has(name))
    .sort(compareAscii);
  if (unsupported.length > 0) {
    throw new Error(`${filename} has external runtime packages: ${unsupported.join(", ")}`);
  }
  if (!runtimeRequires.includes("vscode")) {
    throw new Error(`${filename} does not declare the vscode runtime external`);
  }

  const require = createRequire(import.meta.url);
  const sourceMapRoot = dirname(require.resolve("source-map/package.json", {
    paths: [resolve(repositoryRoot, "extensions/vscode")],
  }));
  assertEqualFile(
    archive,
    filename,
    "extension/dist/mappings.wasm",
    await readFile(resolve(sourceMapRoot, "lib/mappings.wasm")),
  );
  assertEqualFile(
    archive,
    filename,
    "extension/THIRD_PARTY_NOTICES",
    await readFile(resolve(repositoryRoot, "extensions/vscode/THIRD_PARTY_NOTICES")),
  );
}

async function verifySource(archive, filename) {
  await verifySourceAgainstHead(archive, filename, readHeadTree(repositoryRoot));
  assertProjectLicense(archive, filename, "LICENSE");

  const rootManifest = parseJsonFile(archive, filename, "package.json");
  assertVersion(rootManifest.version, `${filename} root package`, VERSION);
  if (
    rootManifest.packageManager !== "pnpm@9.15.0" ||
    rootManifest.devDependencies?.["adm-zip"] !== "0.5.16" ||
    rootManifest.devDependencies?.["web-ext"] !== "10.4.0"
  ) {
    throw new Error(`${filename} has unexpected root packaging dependencies`);
  }
  for (const script of [
    "package:vscode",
    "package:chrome",
    "package:firefox",
    "package:firefox-source",
    "artifacts:verify",
    "artifacts:checksums",
  ]) {
    if (typeof rootManifest.scripts?.[script] !== "string") {
      throw new Error(`${filename} is missing root script ${script}`);
    }
  }
  const firefoxPackage = parseJsonFile(
    archive,
    filename,
    "extensions/firefox/package.json",
  );
  assertVersion(firefoxPackage.version, `${filename} Firefox package`, VERSION);
  if (typeof firefoxPackage.scripts?.package !== "string") {
    throw new Error(`${filename} is missing the Firefox package script`);
  }
  verifyBrowserManifest(
    parseJsonFile(archive, filename, "extensions/firefox/manifest.json"),
    filename,
    "firefox",
  );
}

function rejectZipSymlink(entry, path, filename) {
  const unixMode = ((entry.attr >>> 0) >>> 16) & 0xffff;
  if ((unixMode & 0o170000) === 0o120000) {
    throw new Error(`${filename} contains symbolic link entry ${path}`);
  }
}

function expectedGitArchivePaths(paths) {
  const expected = new Set();
  for (const path of paths) {
    expected.add(path);
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      expected.add(parts.slice(0, index).join("/"));
    }
  }
  return expected;
}

function splitNullTerminated(buffer) {
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) records.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) {
    throw new Error("git ls-tree output was not NUL terminated");
  }
  return records;
}

function readHeadBlob(root, object) {
  return runGit(root, ["cat-file", "blob", object]);
}

function runGit(root, arguments_) {
  const portableRoot = resolve(root).replaceAll("\\", "/");
  const result = spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${portableRoot}`,
      "-C",
      portableRoot,
      ...arguments_,
    ],
    { encoding: null, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${arguments_[0]} failed: ${result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout;
}

function parseJsonFile(archive, filename, path) {
  try {
    return JSON.parse(archive.files.get(path).toString("utf8"));
  } catch (error) {
    throw new Error(`${filename} contains invalid JSON in ${path}: ${error.message}`);
  }
}

function assertProjectLicense(archive, filename, path) {
  try {
    assertTextEqual(
      archive.files.get(path).toString("utf8"),
      projectLicense.toString("utf8"),
    );
  } catch {
    throw new Error(`${filename} contains unexpected content in ${path}`);
  }
}

function assertEqualFile(archive, filename, path, expected) {
  if (!archive.files.get(path).equals(expected)) {
    throw new Error(`${filename} contains unexpected content in ${path}`);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await verifyArtifacts(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
