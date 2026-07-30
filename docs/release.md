# Browser2IDE Release Guide

This is the owner runbook for signed public releases. Version `0.2.0` is still
unreleased: do not create its release tag or publish a GitHub release until AMO
signing and the installed-product verification are ready.

## One-Time Setup

1. Register the Firefox extension in the Mozilla Add-ons Developer Hub for
   unlisted distribution. Its add-on ID must exactly match
   `browser_specific_settings.gecko.id` in
   `extensions/firefox/manifest.json`; the current ID is
   `browser2ide@local`. Changing this value after registration creates a
   different add-on identity.
2. In the Mozilla Developer Hub, create JWT API credentials for the account
   that owns that add-on.
3. In GitHub, open **Settings > Secrets and variables > Actions** and add
   repository secrets named `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`.

Never commit, print, paste into an issue, or store either credential as a
workflow variable. The signing workflow exposes both values only to its single
secret-check and `web-ext sign` step. Revoke and replace both credentials if
either value may have been disclosed.

## Prepare A Version

Update the version in all six product files:

- `package.json`;
- `extensions/vscode/package.json`;
- `extensions/firefox/package.json` and `manifest.json`;
- `extensions/chrome/package.json` and `manifest.json`.

Also update versioned artifact names and expectations in package scripts,
smoke scripts, release tools, tests, and documentation. Search for the previous
version before committing:

```powershell
rg -n '0\.2\.0' package.json extensions tools docs .github
```

Keep the changelog entry under `Unreleased` until the signed XPI has passed the
installed verification. From a clean checkout, run the complete local gate:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:integration
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm exec web-ext lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
corepack pnpm --filter browser2ide-chrome test -- manifest.test.ts adapter.test.ts
corepack pnpm package
git diff --check
git diff --exit-code
```

Review `artifacts/SHA256SUMS` and verify all unsigned local artifacts before
continuing. On Linux or Git Bash:

```bash
cd artifacts
sha256sum --check --strict SHA256SUMS
```

## Commit And Tag

Commit and push the prepared version, then wait for the `CI` workflow on
`master` to pass. Confirm that AMO secrets and the signing path are ready before
creating any release tag.

Create an annotated, cryptographically signed tag and verify it locally:

```powershell
git tag -s v0.2.0 -m "Browser2IDE 0.2.0"
git verify-tag v0.2.0
git push origin master
git push origin v0.2.0
```

Do not replace `-s` with a lightweight tag. Both release workflows reject a
tag that is not an annotated tag object, and every package and manifest version
must exactly match the `vX.Y.Z` tag.

## Create The Draft

Pushing the tag starts the `Release draft` workflow. It checks out the tag,
validates all six versions, runs the complete build/test/integration/lint gate,
packages and verifies the artifacts, and creates a GitHub draft release with:

```text
browser2ide-chrome-X.Y.Z.zip
browser2ide-firefox-X.Y.Z.zip
browser2ide-firefox-source-X.Y.Z.zip
browser2ide-vscode-X.Y.Z.vsix
SHA256SUMS
```

The Firefox ZIP is unsigned and is not suitable for normal Firefox Stable
installation. Leave the release in draft.

## Sign Firefox

In GitHub Actions, run **Sign Firefox and publish release** with the exact tag
and mode `sign`; leave `resume_run_id` empty for this initial submission. The
workflow checks out that tag, rebuilds and verifies the complete unsigned
artifact set, confirms that the release exists and is still a draft, and
invokes `web-ext` 10.4.0 from `extensions/firefox` with channel `unlisted`. It
also submits the verified Firefox source ZIP so Mozilla reviewers can
reproduce the build.

`web-ext` writes the AMO upload UUID, channel, and package CRC to
`extensions/firefox/.amo-upload-uuid` only after AMO validation succeeds. It
writes this state before creating the version and waiting for approval. Thus
the workflow can guarantee stateful resume for an approval timeout or a later
AMO failure, but not for a validation timeout.

After every sign attempt, the workflow's `always()` steps preserve the state
file when it exists as a tag/run-specific GitHub Actions artifact for seven
days. The artifact contains no AMO issuer, secret, or other API credential. A
validation timeout can produce no state artifact because the file has not yet
been written. In that case, `actions/upload-artifact` reports the configured
`if-no-files-found: warn`; the warning is truthful and does not authorize a new
submission.

Mozilla may delay automated signing or require review. Validation and approval
each have an explicit 15-minute timeout; the GitHub job has additional time to
preserve available state after `web-ext` returns. Either timeout can leave work
pending at AMO and is not permission to create another submission.

If a sign run reaches approval timeout or fails later:

1. Do not launch mode `sign` again with an empty `resume_run_id`.
2. Open the AMO Developer Hub and inspect the existing version's status.
3. While the state artifact exists, launch mode `sign` with the same tag and
   set `resume_run_id` to the numeric GitHub run ID that timed out. The workflow
   reconstructs the expected artifact name, restores `.amo-upload-uuid`, and
   asks `web-ext` to continue the same upload.
4. If another resumed run times out, inspect AMO again and use that run's ID for
   the next resume. Never discard available state merely to start over.

If validation timeout occurs or the run has no state artifact, do not use an
empty `resume_run_id` and do not submit again. Follow the Developer Hub recovery
below.

After AMO returns exactly one XPI, the workflow names it
`browser2ide-firefox-X.Y.Z.xpi`, adds it to `SHA256SUMS`, uploads both with
`--clobber`, and verifies the exact signed draft asset set. The unsigned ZIP is
retained as the reproducible build input; the XPI is the Firefox Stable install
artifact.

### Recovery After Missing Or Expired State

A missing or expired state artifact does not justify another AMO submission.
This includes validation timeout, where `web-ext` may have uploaded the package
but could not write resumable state. Check the AMO Developer Hub first. If the
version is pending, wait for Mozilla. If it is approved, download its signed XPI
from the Developer Hub and attach that exact file to the draft. If the Developer
Hub has neither a signed artifact nor a clear status, stop and resolve the
submission with Mozilla before continuing. A new version is required only when
Mozilla rejects the submission or code/metadata changes are needed, not merely
because review is slow or the state artifact is unavailable.

Before changing any release asset, prove the release is still a draft, download
the exact original five-asset unsigned set, and validate every checksum. Only
then add the AMO file. The following commands run in Linux or Git Bash from the
repository root; replace `AMO_DOWNLOAD_DIR` with the directory containing only
the XPI downloaded from the Developer Hub:

```bash
set -euo pipefail
TAG="v0.2.0"
VERSION="$(node tools/verify-release-version.mjs "$TAG")"
RECOVERY_DIR="artifacts/recovery-${VERSION}"
UNSIGNED_RELEASE_JSON="artifacts/recovery-unsigned-${VERSION}.json"
AMO_DOWNLOAD_DIR="/absolute/path/to/amo-download"

test "$(gh release view "$TAG" --json isDraft --jq '.isDraft')" = "true"
test ! -e "$RECOVERY_DIR"
test ! -e "$UNSIGNED_RELEASE_JSON"
mkdir "$RECOVERY_DIR"
gh release download "$TAG" --dir "$RECOVERY_DIR"
gh release view "$TAG" --json isDraft,assets > "$UNSIGNED_RELEASE_JSON"
node tools/verify-release-assets.mjs unsigned "$UNSIGNED_RELEASE_JSON" "$VERSION" "$RECOVERY_DIR/SHA256SUMS"
(cd "$RECOVERY_DIR" && sha256sum --check --strict SHA256SUMS)

mapfile -d '' -t XPI_FILES < <(find "$AMO_DOWNLOAD_DIR" -maxdepth 1 -type f -name '*.xpi' -print0)
test "${#XPI_FILES[@]}" -eq 1
SIGNED_XPI="$RECOVERY_DIR/browser2ide-firefox-${VERSION}.xpi"
test ! -e "$SIGNED_XPI"
mv -- "${XPI_FILES[0]}" "$SIGNED_XPI"

node tools/write-checksums.mjs "$RECOVERY_DIR"
gh release upload "$TAG" "$SIGNED_XPI" "$RECOVERY_DIR/SHA256SUMS" --clobber

VERIFY_DIR="artifacts/recovery-verify-${VERSION}"
RELEASE_JSON="artifacts/recovery-release-${VERSION}.json"
test ! -e "$VERIFY_DIR"
mkdir "$VERIFY_DIR"
gh release download "$TAG" --dir "$VERIFY_DIR"
gh release view "$TAG" --json isDraft,assets > "$RELEASE_JSON"
node tools/verify-release-assets.mjs signed "$RELEASE_JSON" "$VERSION" "$VERIFY_DIR/SHA256SUMS"
(cd "$VERIFY_DIR" && sha256sum --check --strict SHA256SUMS)
```

Complete the installed verification with this XPI, then use mode `publish`.

## Verify Installed Artifacts

Download all six draft assets and validate `SHA256SUMS`. Complete
`docs/installed-verification.md` without development launchers. In particular:

1. install `browser2ide-firefox-X.Y.Z.xpi` in Firefox Stable;
2. restart Firefox and confirm that the signed extension remains installed;
3. install the VSIX and load the Chrome ZIP using the documented release flow;
4. verify linking, DOM selection, CSS/SCSS source opening, and selected/parent
   highlights;
5. preserve the verification record required by the release checklist.

Do not continue if a checksum, signature, restart, or installed workflow check
fails. Fix the code in a new version rather than changing the pushed tag.

## Publish

After installed verification passes, run **Sign Firefox and publish release**
again for the same tag with mode `publish`. This mode does not expose AMO
secrets or sign again. It rebuilds the unsigned artifacts from the tag,
downloads the draft, requires the exact six-file asset set and matching hashes,
then executes `gh release edit <tag> --draft=false`.

Confirm the public release contains only:

```text
browser2ide-chrome-X.Y.Z.zip
browser2ide-firefox-X.Y.Z.zip
browser2ide-firefox-X.Y.Z.xpi
browser2ide-firefox-source-X.Y.Z.zip
browser2ide-vscode-X.Y.Z.vsix
SHA256SUMS
```

Only now move the changelog entry from `Unreleased` to its release date in the
next normal commit. Unlisted AMO signing makes the XPI installable but does not
create a listed AMO store page.

## Rollback And Recovery

If draft creation, signing, or installed verification fails, leave the release
in draft and identify which stage failed. Resume an approval-timeout or later
failure only while its validated state artifact exists. For validation timeout
or missing state, use the Developer Hub recovery above. Do not create another
upload for a version that is pending or already approved.

Never delete, move, or rewrite a pushed release tag, and never remove published
history to hide a defective release. For a code defect, document it and ship a
new patch version and tag. For a credential incident, revoke the AMO credentials
immediately, rotate both GitHub secrets, preserve the release history for audit,
and remove a hosted artifact only when the artifact itself exposes sensitive
material.
