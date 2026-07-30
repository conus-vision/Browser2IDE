import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { compareAscii, normalizeArchivePath } from "./release-policy.mjs";

const DEFAULT_SOURCE_DATE_EPOCH = "1704067200";
const TEXT_ARCHIVE_ENTRY =
  /(?:^|\/)(?:copying|license(?:\.txt)?|notice|third_party_notices|[^/]+\.(?:cjs|css|html?|js|json|map|md|mjs|scss|svg|text|ts|tsx|txt|vsixmanifest|webmanifest|xml|ya?ml))$/i;

export async function normalizeBrowserArchive(path) {
  const absolutePath = resolve(path);
  const source = new AdmZip(absolutePath);
  const files = new Map();
  for (const entry of source.getEntries()) {
    const name = normalizeArchivePath(entry.entryName, absolutePath, entry.isDirectory);
    if (entry.isDirectory) continue;
    if (files.has(name)) throw new Error(`${absolutePath} contains duplicate path ${name}`);
    files.set(name, normalizeEntryData(name, entry.getData(), absolutePath));
  }

  const output = new AdmZip();
  const timestamp = sourceDate();
  for (const name of [...files.keys()].sort(compareAscii)) {
    output.addFile(name, files.get(name), "", 0);
    output.getEntry(name).header.time = timestamp;
  }
  await writeFile(absolutePath, output.toBuffer());
}

function normalizeEntryData(name, data, archivePath) {
  if (!TEXT_ARCHIVE_ENTRY.test(name)) return data;

  const text = data.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(data)) {
    throw new Error(`${archivePath} contains invalid UTF-8 text entry ${name}`);
  }
  return Buffer.from(text.replace(/\r\n?/g, "\n"), "utf8");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    throw new Error("Usage: node tools/normalize-browser-archive.mjs <archive-path>");
  }
  await normalizeBrowserArchive(process.argv[2]);
}

function sourceDate() {
  const value = process.env.SOURCE_DATE_EPOCH ?? DEFAULT_SOURCE_DATE_EPOCH;
  if (!/^\d+$/.test(value)) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
  }
  const milliseconds = Number(value) * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < Date.UTC(1980, 0, 1)) {
    throw new Error("SOURCE_DATE_EPOCH must be a ZIP-safe Unix timestamp on or after 1980-01-01");
  }
  return new Date(milliseconds);
}
