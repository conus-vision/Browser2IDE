import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const installedGuide = await readFile("docs/installed-verification.md", "utf8");
const readme = await readFile("README.md", "utf8");
const developmentGuide = await readFile("docs/mvp-verification.md", "utf8");
const recordHeading = "## 0.2.0 Candidate Verification Record";
const [primaryPath, verificationRecord] = installedGuide.split(recordHeading);

test("installed primary path is terminal-free", () => {
  assert.ok(verificationRecord, "candidate verification record is required");
  for (const prohibited of [
    "--extensionDevelopmentPath",
    "web-ext run",
    "corepack",
    "pnpm",
  ]) {
    assert.equal(primaryPath.includes(prohibited), false, prohibited);
  }
  assert.match(primaryPath, /Install from VSIX/);
  assert.match(primaryPath, /Load unpacked/);
  assert.match(primaryPath, /Install Add-on From File/);
});

test("candidate record distinguishes observed and pending evidence", () => {
  assert.match(verificationRecord, /Pending parent-run evidence/);
  assert.doesNotMatch(verificationRecord, /Observed automated evidence/);
  assert.match(verificationRecord, /INSTALLED_VSIX_ACTIVATION_OK/);
  assert.match(verificationRecord, /PACKAGED_CHROME_MV3_OK/);
  assert.match(verificationRecord, /Pending external release evidence/);
  assert.match(verificationRecord, /No signed `0\.2\.0` XPI exists/);
  assert.match(verificationRecord, /no screenshot or GIF is present/i);
});

test("README points to installed verification without missing media", () => {
  assert.match(readme, /docs\/installed-verification\.md/);
  assert.doesNotMatch(readme, /browser2ide-(?:linking\.png|inspect\.gif)/);
  assert.match(
    developmentGuide,
    /^# Browser2IDE Development Host Verification\r?\n/,
  );
  assert.match(developmentGuide, /installed-verification\.md/);
});
