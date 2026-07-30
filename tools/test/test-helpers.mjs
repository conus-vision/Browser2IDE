import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export async function withTemporaryDirectory(prefix, action) {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
