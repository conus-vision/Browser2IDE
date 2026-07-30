import { builtinModules, createRequire } from "node:module";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import {
  assertVersion,
  assertTextEqual,
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
const REQUIRED_BROWSER_FILES = [
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
const REQUIRED_VSIX_FILES = [
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
const REQUIRED_SOURCE_FILES = [
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "docs/firefox-source-submission.md",
  "extensions/firefox/esbuild.mjs",
  "extensions/firefox/manifest.json",
  "extensions/firefox/package.json",
  "extensions/firefox/tsconfig.json",
  "extensions/firefox/src/background.ts",
  "extensions/firefox/src/contentScript.ts",
  "extensions/firefox/src/devtools.html",
  "extensions/firefox/src/devtools.ts",
  "extensions/firefox/src/panel.ts",
  "packages/browser-extension-core/assets/browser2ide.svg",
  "packages/browser-extension-core/assets/panel.css",
  "packages/browser-extension-core/assets/panel.html",
  "packages/browser-extension-core/package.json",
  "packages/browser-extension-core/tsconfig.json",
  "packages/browser-extension-core/src/index.ts",
  "packages/browser-extension-core/src/backgroundRuntime.ts",
  "packages/browser-extension-core/src/contentScriptRuntime.ts",
  "packages/browser-extension-core/src/devtoolsRuntime.ts",
  "packages/browser-extension-core/src/panelRuntime.ts",
  "packages/protocol/package.json",
  "packages/protocol/tsconfig.json",
  "packages/protocol/src/capabilities.ts",
  "packages/protocol/src/index.ts",
  "packages/protocol/src/json.ts",
  "packages/protocol/src/limits.ts",
  "packages/protocol/src/messages.ts",
  "packages/protocol/src/references.ts",
  "packages/protocol/src/schema.ts",
  "tools/archive-firefox-source.mjs",
  "tools/browser-bundle-notices.mjs",
  "tools/release-policy.mjs",
  "tools/verify-artifacts.mjs",
  "tools/write-checksums.mjs",
];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectLicense = await readFile(resolve(repositoryRoot, "LICENSE"));

try {
  const artifacts = await collectArtifacts(process.argv.slice(2));
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
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
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

function readArchive(path, filename) {
  let zip;
  try {
    zip = new AdmZip(path);
  } catch (error) {
    throw new Error(`${filename} is not a readable ZIP archive: ${error.message}`);
  }

  const files = new Map();
  const seen = new Set();
  for (const entry of zip.getEntries()) {
    const name = normalizeArchivePath(entry.entryName, filename, entry.isDirectory);
    if (seen.has(name)) {
      throw new Error(`${filename} contains duplicate path ${name}`);
    }
    seen.add(name);
    rejectSensitivePath(name, filename);
    if (entry.isDirectory) continue;
    files.set(name, entry.getData());
  }
  return { files, paths: [...seen].sort(compareAscii) };
}

async function verifyBrowser(archive, filename, browser) {
  requireFiles(archive, filename, REQUIRED_BROWSER_FILES);
  for (const path of archive.paths) {
    if (
      /(?:^|\/)(?:src|test)(?:\/|$)/.test(path) ||
      /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|tsconfig\.json|esbuild\.mjs)$/.test(path) ||
      /\.map$/i.test(path)
    ) {
      throw new Error(`${filename} contains forbidden runtime path ${path}`);
    }
  }

  assertProjectLicense(archive, filename, "LICENSE");
  const noticePath = resolve(repositoryRoot, "extensions", browser, "THIRD_PARTY_NOTICES");
  const expectedNotices = await readFile(noticePath);
  assertEqualFile(archive, filename, "THIRD_PARTY_NOTICES", expectedNotices);

  const manifest = parseJsonFile(archive, filename, "manifest.json");
  verifyBrowserManifest(manifest, filename, browser);
}

function verifyBrowserManifest(manifest, filename, browser) {
  if (manifest.manifest_version !== 3) {
    throw new Error(`${filename} has unexpected manifest_version`);
  }
  if (manifest.name !== "Browser2IDE" || manifest.version !== VERSION) {
    throw new Error(`${filename} has unexpected manifest name or version`);
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
  requireFiles(archive, filename, REQUIRED_VSIX_FILES);
  for (const path of archive.paths) {
    if (/(?:^|\/)(?:src|test)(?:\/|$)|\.vscode-test|\.map$/i.test(path)) {
      throw new Error(`${filename} contains forbidden VSIX path ${path}`);
    }
  }
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
  requireFiles(
    archive,
    filename,
    await collectRepositoryTreeFiles([
      "extensions/firefox/src",
      "packages/browser-extension-core/assets",
      "packages/browser-extension-core/src",
      "packages/protocol/src",
    ]),
  );
  requireFiles(archive, filename, REQUIRED_SOURCE_FILES);
  for (const path of archive.paths) {
    if (/^(?:artifacts|node_modules)(?:\/|$)/i.test(path)) {
      throw new Error(`${filename} contains forbidden source path ${path}`);
    }
  }
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
  const requiredScripts = [
    "package:vscode",
    "package:chrome",
    "package:firefox",
    "package:firefox-source",
    "artifacts:verify",
    "artifacts:checksums",
  ];
  for (const script of requiredScripts) {
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

async function collectRepositoryTreeFiles(relativeDirectories) {
  const files = [];
  for (const relativeDirectory of relativeDirectories) {
    await walk(resolve(repositoryRoot, relativeDirectory), relativeDirectory);
  }
  return files.sort(compareAscii);

  async function walk(absoluteDirectory, relativeDirectory) {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`.replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await walk(resolve(absoluteDirectory, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`Source input must be a regular file: ${relativePath}`);
      }
    }
  }
}

function requireFiles(archive, filename, required) {
  for (const path of required) {
    if (!archive.files.has(path)) {
      throw new Error(`${filename} is missing ${path}`);
    }
  }
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
