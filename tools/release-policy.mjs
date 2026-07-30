export function normalizeArchivePath(path, filename, isDirectory) {
  if (path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`${filename} contains dangerous archive path ${path}`);
  }
  const slashNormalized = path.replaceAll("\\", "/");
  const normalized = isDirectory && slashNormalized.endsWith("/")
    ? slashNormalized.slice(0, -1)
    : slashNormalized;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${filename} contains dangerous archive path ${path}`);
  }
  return normalized;
}

export function rejectSensitivePath(path, filename) {
  const segments = path.toLowerCase().split("/");
  if (
    segments.some((segment) =>
      segment === "node_modules" ||
      segment === ".vscode-test" ||
      /^\.env(?:\.|$)/.test(segment) ||
      /^(?:credentials?|secrets?)(?:\.|$)/.test(segment)
    )
  ) {
    throw new Error(`${filename} contains forbidden path ${path}`);
  }
}

export function assertVersion(actual, label, expected) {
  if (actual !== expected) {
    throw new Error(`${label} version must be ${expected}, received ${String(actual)}`);
  }
}

export function assertAsciiFilename(filename) {
  if (!/^[\x20-\x7e]+$/.test(filename)) {
    throw new Error(`Artifact filename must contain printable ASCII only: ${filename}`);
  }
}

export function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
