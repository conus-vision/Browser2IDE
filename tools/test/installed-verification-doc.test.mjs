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

test("VSIX verification starts in a dedicated empty VS Code profile", () => {
  const createProfile = primaryPath.indexOf("Manage > Profiles > Create Profile");
  const installVsix = primaryPath.indexOf("Install from VSIX...");

  assert.ok(createProfile >= 0, "VS Code profile creation UI path is required");
  assert.ok(installVsix >= 0, "VSIX installation UI path is required");
  assert.ok(createProfile < installVsix, "create the isolated profile before installing");
  assert.match(primaryPath, /empty profile/);
  assert.match(primaryPath, /Browser2IDE 0\.2\.0 Candidate/);
});

test("installed verification presents privacy and security before installation", () => {
  const privacy = primaryPath.indexOf("## Privacy And Security Before Testing");
  const install = primaryPath.indexOf("## Install VS Code");

  assert.ok(privacy >= 0, "privacy and security section is required");
  assert.ok(privacy < install, "privacy disclosure must precede installation");
  assert.match(primaryPath, /loopback\s+WebSocket/);
  assert.match(primaryPath, /read-only/);
  assert.match(primaryPath, /`<all_urls>`/);
  assert.match(primaryPath, /full page URL, including its route/);
  assert.match(primaryPath, /`data-\*`, `aria-\*`, and `role`/);
  assert.match(primaryPath, /CSS and development\s+source\s+metadata/);
  for (const excluded of [
    "cookies",
    "headers",
    "form values",
    "DOM text",
  ]) {
    assert.match(primaryPath, new RegExp(excluded));
  }
  assert.match(
    primaryPath,
    /browser side does not collect or\s+send workspace source text/i,
  );
  assert.match(
    primaryPath,
    /local VS Code source plugins read\s+relevant workspace source files and source maps/i,
  );
  assert.match(primaryPath, /not\s+uploaded to a remote Browser2IDE service/i);
  assert.match(primaryPath, /Avoid sensitive or private pages/);
  assert.match(primaryPath, /third-party source plugins separately/);
  assert.match(primaryPath, /\.\.\/PRIVACY\.md/);
  assert.match(primaryPath, /\.\.\/SECURITY\.md/);
});

test("candidate record distinguishes observed and pending evidence", () => {
  assert.match(verificationRecord, /Observed artifact smoke evidence/);
  assert.match(verificationRecord, /exited with code 0/);
  assert.match(verificationRecord, /INSTALLED_VSIX_ACTIVATION_OK/);
  assert.match(verificationRecord, /PACKAGED_CHROME_MV3_OK/);
  assert.match(verificationRecord, /Chrome Stable 150\.0\.7871\.187/);
  assert.match(verificationRecord, /Pending external release evidence/);
  assert.match(verificationRecord, /No signed `0\.2\.0` XPI exists/);
  assert.match(verificationRecord, /no screenshot or GIF is present/i);
  assert.match(
    verificationRecord,
    /Linux[\s\S]*graphical session or Xvfb[\s\S]*DISPLAY[\s\S]*WAYLAND_DISPLAY/,
  );
});

test("candidate record binds smoke evidence to exact source and artifact bytes", () => {
  assert.match(
    verificationRecord,
    /Candidate source commit: `15ad8893945048d68314ed0665b38eb2738929c9`\./,
  );
  assert.match(
    verificationRecord,
    /`browser2ide-vscode-0\.2\.0\.vsix` SHA-256:\s*`f766b5ed7d898747c8af8ee15b7342933f0a4901f40bce058efd08af07e91929`\./,
  );
  assert.match(
    verificationRecord,
    /`browser2ide-chrome-0\.2\.0\.zip` SHA-256:\s*`0a2126d1df3c957982209f56998fa892187e8030d448275924692d8d7dede34e`\./,
  );
  assert.match(
    verificationRecord,
    /`INSTALLED_VSIX_ACTIVATION_OK browser2ide\.browser2ide-vscode`\./,
  );
  assert.match(
    verificationRecord,
    /`PACKAGED_CHROME_MV3_OK Chrome\/150\.0\.7871\.187 Browser2IDE 0\.2\.0\s+fabfckmgcbokjighbhnningclbckebik\/dist\/background\.js`\./,
  );
  assert.equal(
    (verificationRecord.match(/PACKAGED_CHROME_MV3_OK/g) ?? []).length,
    1,
  );
});

test("README points to installed verification without missing media", () => {
  assert.match(readme, /docs\/installed-verification\.md/);
  assert.doesNotMatch(readme, /browser2ide-(?:linking\.png|inspect\.gif)/);
  assert.match(
    developmentGuide,
    /^# Browser2IDE Development Host Verification\r?\n/,
  );
  assert.match(developmentGuide, /installed-verification\.md/);
  assert.match(
    developmentGuide,
    /smoke:chrome-package[\s\S]*Linux[\s\S]*Xvfb/,
  );
});
