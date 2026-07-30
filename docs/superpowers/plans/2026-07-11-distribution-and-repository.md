# Browser2IDE Distribution And Repository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the verified monorepo into an MIT-licensed public project with installable VSIX, Chrome ZIP, and Mozilla-signed unlisted Firefox XPI artifacts, reproducible CI/release workflows, repository documentation, and a terminal-free installed-product runbook.

**Architecture:** All runtime dependencies are bundled before packaging. VS Code is packaged with `@vscode/vsce --no-dependencies`; Chrome and Firefox use browser-specific built directories validated before ZIP/XPI creation. Pull requests run the complete non-secret gate, tags create a draft release and unsigned artifacts, and a separate secret-bearing workflow signs Firefox through AMO before publishing the release.

**Tech Stack:** Node.js 22, pnpm 9, GitHub Actions, @vscode/vsce, web-ext 10.4, GitHub CLI, Mozilla AMO unlisted signing, SHA-256 checksums, Markdown/Mermaid.

---

## Execution Preconditions

- Complete the runtime and browser-adapter plans first.
- Begin with Firefox and Chrome builds passing from shared browser core.
- Use branch or worktree `feat/distribution-repository`.
- Do not create a public release or push a tag until installed-artifact manual
  verification passes.
- AMO credentials must be configured as GitHub Actions secrets by the repository
  owner; never request that they be committed or pasted into chat/logs.

## Planned Public Surface

```text
README.md
LICENSE
CHANGELOG.md
CONTRIBUTING.md
SECURITY.md
PRIVACY.md
.github/
  ISSUE_TEMPLATE/bug-report.yml
  ISSUE_TEMPLATE/feature-request.yml
  ISSUE_TEMPLATE/config.yml
  pull_request_template.md
  workflows/ci.yml
  workflows/release.yml
  workflows/firefox-sign.yml
docs/
  architecture.md
  installed-verification.md
  release.md
  assets/browser2ide-linking.png
  assets/browser2ide-inspect.gif
tools/
  verify-artifacts.mjs
  write-checksums.mjs
```

### Task 1: Add License And Public Project Documentation

**Files:**
- Create: `LICENSE`
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `PRIVACY.md`
- Create: `docs/architecture.md`
- Modify: `package.json`

- [ ] **Step 1: Add the approved MIT license**

Create `LICENSE` with the standard MIT text and:

```text
Copyright (c) 2026 conus-vision
```

Do not add a different license to package subdirectories.

- [ ] **Step 2: Write the root README**

Use this repository description as the opening sentence:

```text
Connect browser DevTools to your IDE and highlight the source code related to a selected DOM element.
```

The README must contain these concrete sections in this order:

```markdown
# Browser2IDE

> Alpha: the protocol and installation formats may change before 1.0.

## What It Does
## Current Support
## Install
## Link A Browser Window
## Verify CSS And SCSS
## Architecture
## Source Plugins
## Security And Privacy
## Development
## Roadmap
## Contributing
## License
```

`Current Support` must use a table that states Firefox Stable, Chrome, local VS
Code, CSS, and source-mapped SCSS are supported; Remote SSH/WSL, public stores,
and write/reverse-sync behavior are not. `Install` links exact GitHub Release
artifact names. `Link A Browser Window` describes copy, paste, all tabs in one
window, separate other windows, Change IDE, Unlink, and manual inspect mode.

Use one Mermaid architecture diagram instead of an unverified product image
until Task 7 captures real installed-product assets.

- [ ] **Step 3: Write contributor and policy documents**

`CONTRIBUTING.md` requires Node 22, Corepack, separate gate commands, TDD,
Conventional Commits, no secrets, and links the plugin guide.

`SECURITY.md` directs private reports to GitHub private vulnerability reporting,
states supported version `0.2.x`, and explicitly forbids public issues for
unpatched vulnerabilities.

`PRIVACY.md` states that Browser2IDE has no analytics or remote service; browser
URL, DOM identifiers/attributes, CSS facts, and source-map references travel
only over loopback WebSocket to the explicitly linked VS Code window. It lists
permissions and purposes for `activeTab`, `clipboardRead`, `scripting`,
`storage`, `tabs`, loopback hosts, and optional inspected-page access. It states
that clipboard is read only on the paste button gesture and code/text contents
are not collected.

`CHANGELOG.md` starts with `## [0.2.0] - Unreleased` and groups the implemented
runtime, browser, source-plugin, packaging, and security features under Added,
Changed, and Security.

- [ ] **Step 4: Write architecture documentation**

`docs/architecture.md` must show protocol, bridge, browser-window coordinator,
VS Code presenter, source-plugin API, trust boundaries, all-tab multiplexing,
and the explicit no-auto-discovery rule. Link `docs/protocol.md`,
`docs/security.md`, and `docs/source-plugin-authoring.md` rather than duplicating
their full contracts.

- [ ] **Step 5: Add root package metadata and validate links**

Add to root `package.json`:

```json
"description": "Connect browser DevTools to your IDE and highlight the source code related to a selected DOM element.",
"license": "MIT",
"repository": {
  "type": "git",
  "url": "https://github.com/conus-vision/Browser2IDE.git"
},
"bugs": "https://github.com/conus-vision/Browser2IDE/issues",
"homepage": "https://github.com/conus-vision/Browser2IDE#readme"
```

Run:

```powershell
rg -n "conus-vision/Browser2IDE|MIT|Node\.js 22|clipboardRead|127\.0\.0\.1" README.md CONTRIBUTING.md SECURITY.md PRIVACY.md docs/architecture.md package.json
git diff --check
```

Expected: every public identifier is documented and whitespace check is clean.

- [ ] **Step 6: Commit public documentation**

```powershell
git add LICENSE README.md CHANGELOG.md CONTRIBUTING.md SECURITY.md PRIVACY.md docs/architecture.md package.json
git commit -m "docs: add public project materials"
```

### Task 2: Add GitHub Contribution Templates

**Files:**
- Create: `.github/ISSUE_TEMPLATE/bug-report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature-request.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Create: `.github/pull_request_template.md`

- [ ] **Step 1: Create a structured bug form**

Require Browser2IDE version, VS Code version, browser/version, source type,
operating system, steps, expected/actual behavior, diagnostics with credentials
removed, and confirmation that no PIN/token is included. Add a required checkbox
that the reporter searched existing issues.

- [ ] **Step 2: Create feature and PR forms**

Feature requests require problem, workflow, proposed behavior, alternatives,
and whether protocol/plugin APIs change. The PR template requires linked issue,
change summary, tests, manual verification, documentation, protocol compatibility,
and confirmation that no credentials/generated build artifacts were committed.

Set `blank_issues_enabled: false` and provide a private security contact link:

```yaml
contact_links:
  - name: Security vulnerability
    url: https://github.com/conus-vision/Browser2IDE/security/advisories/new
    about: Report vulnerabilities privately.
```

- [ ] **Step 3: Parse every YAML form and verify required fields**

Add `yaml` as a root dev dependency and run a small inline Node check:

```powershell
corepack pnpm add -Dw yaml@2.8.1
corepack pnpm exec node -e "const fs=require('fs'); const YAML=require('yaml'); for (const f of fs.readdirSync('.github/ISSUE_TEMPLATE').filter(x=>x.endsWith('.yml'))) YAML.parse(fs.readFileSync('.github/ISSUE_TEMPLATE/'+f,'utf8')); console.log('issue forms ok')"
```

Expected: prints `issue forms ok`.

- [ ] **Step 4: Commit templates**

```powershell
git add .github/ISSUE_TEMPLATE .github/pull_request_template.md package.json pnpm-lock.yaml
git commit -m "chore(github): add contribution templates"
```

### Task 3: Package The VS Code Extension As VSIX

**Files:**
- Create: `extensions/vscode/.vscodeignore`
- Create: `extensions/vscode/README.md`
- Create: `extensions/vscode/LICENSE`
- Modify: `extensions/vscode/package.json`
- Modify: `extensions/firefox/package.json`
- Modify: `extensions/chrome/package.json`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add failing package metadata tests**

Extend `extensions/vscode/test/manifest.test.ts`:

```ts
expect(manifest).toMatchObject({
  version: "0.2.0",
  license: "MIT",
  repository: "https://github.com/conus-vision/Browser2IDE.git",
  extensionKind: ["ui"],
});
expect(manifest.private).not.toBe(true);
expect(manifest.scripts["vscode:prepublish"]).toBe("pnpm run build");
```

- [ ] **Step 2: Run manifest test and verify RED**

```powershell
corepack pnpm --filter browser2ide-vscode test -- manifest.test.ts
```

Expected: FAIL on version/package metadata.

- [ ] **Step 3: Make the extension packageable**

Set version `0.2.0` in the root, VS Code, Firefox, and Chrome manifests so the
release tag and three artifact names share one version. Remove `private` only
from the VS Code publishable manifest, and add license, repository, homepage,
bugs, categories (`Other`, `Programming Languages`), and keywords. Add:

```json
"scripts": {
  "vscode:prepublish": "pnpm run build",
  "package": "vsce package --no-dependencies --out ../../artifacts/browser2ide-vscode-0.2.0.vsix"
}
```

Add `@vscode/vsce` as a VS Code package dev dependency. `--no-dependencies` is
required because runtime dependencies are bundled by esbuild and workspace
protocol/plugin packages must not be traversed by npm.

- [ ] **Step 4: Add package-only docs and ignore rules**

`extensions/vscode/README.md` gives the install/link/verify path and links the
repository. Copy the exact MIT text into `extensions/vscode/LICENSE` so it is
inside VSIX.

`.vscodeignore` excludes source, tests, `.vscode-test`, TypeScript/esbuild
configs, source maps not needed for runtime, and `node_modules`; it includes
`dist/extension.cjs`, `package.json`, README, LICENSE, and `resources/**`.

Add `artifacts/` and `web-ext-artifacts/` to root `.gitignore`.

- [ ] **Step 5: Build and inspect VSIX**

```powershell
corepack pnpm install
corepack pnpm --filter browser2ide-vscode run package
corepack pnpm --filter browser2ide-vscode exec vsce ls --no-dependencies
```

Expected: `artifacts/browser2ide-vscode-0.2.0.vsix` exists; the listing contains
the bundled extension, manifest, README, LICENSE, and resources, and excludes
source/tests/node_modules.

- [ ] **Step 6: Commit VSIX packaging**

```powershell
git add extensions/vscode package.json pnpm-lock.yaml .gitignore
git commit -m "build(vscode): package installable VSIX"
```

### Task 4: Package Chrome And Firefox Artifacts

**Files:**
- Modify: `extensions/firefox/package.json`
- Modify: `extensions/chrome/package.json`
- Modify: `package.json`
- Create: `tools/verify-artifacts.mjs`
- Create: `tools/write-checksums.mjs`
- Create: `docs/firefox-source-submission.md`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing artifact verifier**

Create `tools/verify-artifacts.mjs` that receives artifact paths, opens ZIP/VSIX
archives with `adm-zip`, and fails unless:

```js
const requiredBrowserFiles = [
  "manifest.json",
  "dist/background.js",
  "dist/contentScript.js",
  "dist/devtools.html",
  "dist/devtools.js",
  "dist/panel.html",
  "dist/panel.js",
  "dist/panel.css",
];
```

For VSIX require `extension/package.json`, `extension/dist/extension.cjs`,
`extension/dist/mappings.wasm`, `extension/readme.md`,
`extension/LICENSE.txt`, and `extension/THIRD_PARTY_NOTICES`. Reject `.env`,
`node_modules/`, source maps, and any path containing `.vscode-test`.

- [ ] **Step 2: Add packaging dependencies and scripts**

Add `adm-zip@0.5.16` as a root dev dependency. Browser package scripts:

```json
"package": "pnpm run build && web-ext build --overwrite-dest --artifacts-dir ../../artifacts --filename browser2ide-<browser>-0.2.0.zip --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs \"src/**\" \"test/**\""
```

Use `<browser>` as the literal `chrome` or `firefox` in its package. Add
`web-ext@10.4.0` as a root dev dependency so CI does not download an unpinned
tool.

Root scripts:

```json
"prepackage": "node -e \"require('node:fs').mkdirSync('artifacts',{recursive:true})\"",
"package": "pnpm package:vscode && pnpm package:chrome && pnpm package:firefox && pnpm package:firefox-source && pnpm artifacts:verify && pnpm artifacts:checksums",
"package:vscode": "pnpm --filter browser2ide-vscode run package",
"package:chrome": "pnpm --filter browser2ide-chrome run package",
"package:firefox": "pnpm --filter browser2ide-firefox run package",
"package:firefox-source": "git archive --format=zip --output=artifacts/browser2ide-firefox-source-0.2.0.zip HEAD",
"artifacts:verify": "node tools/verify-artifacts.mjs artifacts",
"artifacts:checksums": "node tools/write-checksums.mjs artifacts"
```

- [ ] **Step 3: Implement deterministic checksums**

`write-checksums.mjs` reads regular artifact files except `SHA256SUMS`, sorts by
filename, hashes each with Node `createHash("sha256")`, and writes:

```text
<64 lowercase hex characters>  <filename>
```

to `artifacts/SHA256SUMS` with LF endings.

- [ ] **Step 4: Write Mozilla source build instructions**

`docs/firefox-source-submission.md` specifies Node 22, Corepack, exact install
and Firefox build commands, output paths, committed lockfile, no generated code
download, and why bundled/minified files are reproducible. It must be sufficient
for a Mozilla reviewer starting from the source ZIP.

- [ ] **Step 5: Package and verify all unsigned artifacts**

```powershell
if (Test-Path artifacts) { Remove-Item -Recurse -Force -LiteralPath artifacts }
New-Item -ItemType Directory -Path artifacts | Out-Null
corepack pnpm install --frozen-lockfile
corepack pnpm package
Get-Content artifacts/SHA256SUMS
```

Expected: VSIX, Chrome ZIP, unsigned Firefox ZIP, Firefox source ZIP, and
checksums exist; verifier exits 0.

- [ ] **Step 6: Commit browser packaging**

```powershell
git add extensions/firefox/package.json extensions/chrome/package.json package.json pnpm-lock.yaml tools docs/firefox-source-submission.md .gitignore
git commit -m "build: package release artifacts"
```

### Task 5: Add The Pull-Request CI Gate

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`

- [ ] **Step 1: Create CI workflow**

Use `pull_request` and pushes to `master`, `permissions: contents: read`, one
Ubuntu job, `actions/checkout@v4`, `actions/setup-node@v4` with Node 22 and pnpm
cache, then:

```yaml
- run: corepack enable
- run: corepack pnpm install --frozen-lockfile
- run: corepack pnpm build
- run: corepack pnpm test
- run: xvfb-run -a corepack pnpm test:integration
- run: corepack pnpm typecheck
- run: corepack pnpm lint
- run: corepack pnpm exec web-ext lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
- run: corepack pnpm --filter browser2ide-chrome test -- manifest.test.ts adapter.test.ts
- run: corepack pnpm package
- run: git diff --check
```

Set a 20-minute timeout and cancel superseded runs with a workflow concurrency
group keyed by workflow/ref.

- [ ] **Step 2: Validate workflow YAML locally**

```powershell
corepack pnpm exec node -e "const fs=require('fs'); const YAML=require('yaml'); YAML.parse(fs.readFileSync('.github/workflows/ci.yml','utf8')); console.log('ci workflow ok')"
```

Expected: prints `ci workflow ok`.

- [ ] **Step 3: Add the CI badge after origin exists**

Add this exact badge below the README title:

```markdown
[![CI](https://github.com/conus-vision/Browser2IDE/actions/workflows/ci.yml/badge.svg)](https://github.com/conus-vision/Browser2IDE/actions/workflows/ci.yml)
```

- [ ] **Step 4: Commit CI**

```powershell
git add .github/workflows/ci.yml README.md
git commit -m "ci: add monorepo verification gate"
```

### Task 6: Add Draft Release And Firefox AMO Signing Workflows

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/firefox-sign.yml`
- Create: `docs/release.md`

- [ ] **Step 1: Create tagged draft-release workflow**

Trigger on `v*` tags, grant `contents: write`, verify that tag `vX.Y.Z` equals
root, VS Code, Firefox, and Chrome package versions, run the full package gate,
and create a draft release:

```yaml
- name: Create draft release
  env:
    GH_TOKEN: ${{ github.token }}
  run: >-
    gh release create "${{ github.ref_name }}"
    artifacts/*
    --draft
    --verify-tag
    --title "Browser2IDE ${{ github.ref_name }}"
    --generate-notes
```

The release remains draft because the Firefox ZIP is unsigned.

- [ ] **Step 2: Create secret-bearing Firefox signing workflow**

Use `workflow_dispatch` with required `tag`. Check out that tag, build Firefox,
and fail immediately if either secret is absent. Sign only from
`extensions/firefox`:

```yaml
- name: Sign unlisted Firefox XPI
  env:
    WEB_EXT_API_KEY: ${{ secrets.AMO_JWT_ISSUER }}
    WEB_EXT_API_SECRET: ${{ secrets.AMO_JWT_SECRET }}
  run: >-
    corepack pnpm exec web-ext sign
    --channel=unlisted
    --source-dir=extensions/firefox
    --artifacts-dir=artifacts/firefox-signed
    --api-key="$WEB_EXT_API_KEY"
    --api-secret="$WEB_EXT_API_SECRET"
    --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
    --timeout=900000
```

Rename the returned XPI to `browser2ide-firefox-0.2.0.xpi`, update
`SHA256SUMS`, upload both with `gh release upload --clobber`, verify VSIX, Chrome
ZIP, source ZIP, and signed XPI are present, then run `gh release edit <tag>
--draft=false`.

Never echo secrets and never run this workflow on pull requests.

- [ ] **Step 3: Write exact owner release instructions**

`docs/release.md` covers AMO add-on ID, creating AMO API credentials, adding the
two GitHub secrets, version updates, full local gate, signed tag, draft workflow,
manual signing dispatch, possible Mozilla review delay, artifact verification,
release publication, and rollback without deleting published Git history.

- [ ] **Step 4: Parse workflows and commit**

```powershell
corepack pnpm exec node -e "const fs=require('fs'); const YAML=require('yaml'); for (const f of ['release.yml','firefox-sign.yml']) YAML.parse(fs.readFileSync('.github/workflows/'+f,'utf8')); console.log('release workflows ok')"
git add .github/workflows/release.yml .github/workflows/firefox-sign.yml docs/release.md
git commit -m "ci: add signed release workflows"
```

Expected: YAML parser succeeds and commit contains no credential values.

### Task 7: Verify Installed Artifacts Without Development Launchers

**Files:**
- Create: `docs/installed-verification.md`
- Create after real capture: `docs/assets/browser2ide-linking.png`
- Create after real capture: `docs/assets/browser2ide-inspect.gif`
- Modify: `README.md`
- Modify: `docs/mvp-verification.md`

- [ ] **Step 1: Write the installed-product runbook**

The primary path must contain no `--extensionDevelopmentPath` and no `web-ext
run`. It instructs the tester to install the VSIX, extracted Chrome ZIP, and
signed Firefox XPI through each application's UI; restart all three; open two
VS Code windows and two browser windows; explicitly link by copied code; verify
all-tab sharing, separate-window isolation, Change IDE, Unlink, manual inspect,
CSS/SCSS Selected/Parent ranges, status start/stop, stale instance rejection,
and cleanup.

Keep contributor commands in `docs/mvp-verification.md`, rename its heading to
`Development Host Verification`, and link the installed runbook first.

- [ ] **Step 2: Install and smoke-test the VSIX**

Use a dedicated VS Code profile from the UI. Install
`artifacts/browser2ide-vscode-0.2.0.vsix`, restart VS Code, verify the status
code appears without a terminal, click-copy it, stop/start it, and record the
actual observed states in the runbook's verification record.

- [ ] **Step 3: Install and smoke-test Chrome**

Extract the Chrome ZIP, enable Developer mode, use `Load unpacked`, restart
Chrome, open DevTools on the fixture, explicitly link, and verify the extension
remains installed and no terminal process is needed.

- [ ] **Step 4: Install and smoke-test Firefox Stable**

After Task 6 produces the signed XPI, install it with `Install Add-on From
File`, restart Firefox Stable, open DevTools, explicitly link, and verify the
extension remains installed without `web-ext`.

- [ ] **Step 5: Capture real documentation assets**

Capture `browser2ide-linking.png` from the verified VS Code status bar plus
DevTools link state without exposing tokens, unrelated workspace names, or
private browser content. Capture a short GIF showing explicit link, DOM select,
and complete Selected/Parent SCSS highlights. Optimize the assets while keeping
text readable at README width. Do not use mockups or generated screenshots.

- [ ] **Step 6: Add verified assets to README**

Place the GIF below `What It Does`, the linking screenshot in `Link A Browser
Window`, include descriptive alt text, and state which version/artifacts were
used.

- [ ] **Step 7: Commit installed verification evidence**

```powershell
git add docs/installed-verification.md docs/mvp-verification.md docs/assets README.md
git commit -m "docs: verify installed Browser2IDE flow"
```

### Task 8: Final Review, GitHub Metadata, And Initial Push

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-07-11-zero-terminal-window-linking-design.md`

- [ ] **Step 1: Run the final local gate from a clean artifact directory**

```powershell
if (Test-Path artifacts) { Remove-Item -Recurse -Force -LiteralPath artifacts }
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:integration
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm exec web-ext lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
corepack pnpm package
git diff --check
git status --short
```

Expected: every command exits 0; artifacts verify; Git status contains only
intentional final documentation changes and the preserved unrelated old plan.

- [ ] **Step 2: Request final code, security, and release review**

Review the complete three-plan commit range against the approved design. Require
separate attention to protocol role routing, PIN rate limiting, origin checks,
token/log redaction, browser-window isolation, package contents, workflow secret
scope, and installation accuracy. Fix every Critical and Important finding and
rerun the affected suites plus the full gate.

- [ ] **Step 3: Finalize release notes and spec status**

Move `CHANGELOG.md` version `0.2.0` from Unreleased to the actual release date.
Set the design spec status to `Implemented and verified`. Commit only those
reviewed changes:

```powershell
git add CHANGELOG.md docs/superpowers/specs/2026-07-11-zero-terminal-window-linking-design.md
git commit -m "docs: finalize 0.2.0 release"
```

- [ ] **Step 4: Configure the empty GitHub repository as origin**

```powershell
git remote add origin https://github.com/conus-vision/Browser2IDE.git
git remote -v
```

If `origin` already exists, verify it matches exactly instead of replacing it.

- [ ] **Step 5: Push reviewed history and configure repository metadata**

```powershell
git push -u origin master
gh repo edit conus-vision/Browser2IDE --description "Connect browser DevTools to your IDE and highlight the source code related to a selected DOM element." --add-topic browser-extension --add-topic devtools --add-topic vscode-extension --add-topic websocket --add-topic css --add-topic scss --add-topic source-maps
```

Expected: `master` is visible in the public repository with CI running and the
approved description/topics. Do not push a release tag until AMO secrets are
configured and the signed-XPI path is ready.

- [ ] **Step 6: Create and verify the release only after signing is ready**

```powershell
git tag -a v0.2.0 -m "Browser2IDE 0.2.0"
git push origin v0.2.0
```

Wait for the draft workflow, dispatch Firefox signing for `v0.2.0`, verify the
signed XPI installs in Firefox Stable, and confirm the workflow publishes the
release only after all required artifacts are attached.

## Completion Checklist

- [ ] Repository uses MIT and contains complete public contribution/security/privacy materials.
- [ ] VSIX installs and auto-starts in normal VS Code without a terminal.
- [ ] Chrome ZIP persists after one-time Load unpacked installation.
- [ ] Firefox Stable accepts the Mozilla-signed unlisted XPI.
- [ ] Firefox source archive reproduces the submitted browser build.
- [ ] PR CI runs build, unit, Extension Host, type, lint, manifest, package, and whitespace gates.
- [ ] Release workflow keeps artifacts draft until signed XPI exists.
- [ ] AMO secrets are scoped only to manual signing and never logged.
- [ ] Artifact verifier rejects missing files and accidental secrets/dependencies.
- [ ] Real installed-product screenshot and GIF are present and privacy-reviewed.
- [ ] Terminal-free installed runbook passes for VS Code, Chrome, and Firefox Stable.
- [ ] Public GitHub description, topics, history, and CI match the approved project design.
