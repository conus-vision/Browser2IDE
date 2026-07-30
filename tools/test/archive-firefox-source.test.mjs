import assert from "node:assert/strict";
import test from "node:test";
import { archiveArguments } from "../archive-firefox-source.mjs";

test("source archive scopes Git safe.directory to the current repository", () => {
  assert.deepEqual(
    archiveArguments(
      "F:\\repo\\browser2ide",
      "F:\\repo\\browser2ide\\artifacts\\source.zip",
    ),
    [
      "-c",
      "safe.directory=F:/repo/browser2ide",
      "-c",
      "core.autocrlf=false",
      "archive",
      "--format=zip",
      "--output=F:/repo/browser2ide/artifacts/source.zip",
      "HEAD",
    ],
  );
});
