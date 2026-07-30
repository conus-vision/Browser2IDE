import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "../..");

test("tag workflow builds a verified draft release", async () => {
  const source = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
  const workflow = YAML.parse(source);

  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.equal(workflow.permissions.contents, "write");
  const checkout = workflow.jobs.package.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.match(source, /verify-release-version\.mjs/);
  assert.match(source, /git cat-file -t/);
  assert.match(source, /git merge-base --is-ancestor/);
  assert.match(source, /refs\/remotes\/origin\/master/);
  assert.match(source, /corepack pnpm package/);
  assert.match(source, /gh release create/);
  assert.match(source, /--draft/);
  assert.match(source, /artifacts\/SHA256SUMS/);
  assert.doesNotMatch(source, /run:[^\n]*\$\{\{ github\.ref_name \}\}/);
  assert.doesNotMatch(source, /AMO_JWT_(?:ISSUER|SECRET)/);

  assertGhTokenIsScopedToGhSteps(workflow.jobs.package.steps);
});

test("Firefox signing is manual, tag-bound, and publishes only after asset verification", async () => {
  const source = await readFile(
    resolve(root, ".github/workflows/firefox-sign.yml"),
    "utf8",
  );
  const workflow = YAML.parse(source);

  assert.ok(workflow.on.workflow_dispatch);
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.resume_run_id.required, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.resume_run_id.type, "string");
  assert.match(workflow.on.workflow_dispatch.inputs.resume_run_id.description, /approval/i);
  assert.doesNotMatch(workflow.on.workflow_dispatch.inputs.resume_run_id.description, /validation/i);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, ["sign", "publish"]);
  assert.equal(workflow.permissions.contents, "write");
  assert.equal(workflow.permissions.actions, "read");
  assert.equal(workflow.on.pull_request, undefined);
  assert.ok(workflow.jobs.sign["timeout-minutes"] >= 60);
  assert.equal(workflow.jobs.sign.environment, undefined);
  const checkout = workflow.jobs.sign.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.match(source, /refs\/tags\/\$RELEASE_TAG/);
  assert.match(source, /git merge-base --is-ancestor/);
  assert.match(source, /refs\/remotes\/origin\/master/);
  assert.match(source, /verify-release-version\.mjs/);
  assert.match(source, /corepack pnpm package/);
  assert.match(source, /--channel=unlisted/);
  assert.match(source, /AMO_JWT_ISSUER/);
  assert.match(source, /AMO_JWT_SECRET/);
  assert.match(source, /verify-release-assets\.mjs/);
  assert.match(source, /sha256sum --check --strict SHA256SUMS/);
  assert.match(source, /gh release edit.*--draft=false/);
  assert.match(source, /if: inputs\.mode == 'publish'/);

  const signStep = workflow.jobs.sign.steps.find(
    (step) => step.name === "Check secrets and sign unlisted Firefox XPI",
  );
  assert.ok(signStep);
  assert.equal(signStep.env.WEB_EXT_API_KEY, "${{ secrets.AMO_JWT_ISSUER }}");
  assert.equal(signStep.env.WEB_EXT_API_SECRET, "${{ secrets.AMO_JWT_SECRET }}");
  assert.match(signStep.run, /-z "\$\{WEB_EXT_API_KEY:-\}"/);
  assert.match(signStep.run, /-z "\$\{WEB_EXT_API_SECRET:-\}"/);
  assert.match(signStep.run, /web-ext sign/);
  assert.match(signStep.run, /--upload-source-code=/);
  assert.match(signStep.run, /--no-input/);
  assert.match(signStep.run, /--no-config-discovery/);
  assert.match(signStep.run, /--approval-timeout=900000/);
  assert.match(signStep.run, /--timeout=900000/);
  assert.doesNotMatch(signStep.run, /--api-key|--api-secret/);
  assert.equal(
    workflow.jobs.sign.steps.filter((step) =>
      Object.keys(step.env ?? {}).some((name) => name.startsWith("WEB_EXT_API_")),
    ).length,
    1,
  );

  const restoreStep = workflow.jobs.sign.steps.find(
    (step) => step.name === "Restore prior AMO upload state",
  );
  assert.equal(restoreStep.uses, "actions/download-artifact@v4");
  assert.match(restoreStep.if, /resume_run_id/);
  assert.equal(restoreStep.with.path, "extensions/firefox");
  assert.equal(restoreStep.with["run-id"], "${{ inputs.resume_run_id }}");
  assert.match(restoreStep.with.name, /steps\.release\.outputs\.resume_state_artifact/);

  const preserveStep = workflow.jobs.sign.steps.find(
    (step) => step.name === "Prepare available AMO upload state for preservation",
  );
  assert.match(preserveStep.if, /always\(\)/);
  assert.match(preserveStep.if, /steps\.amo_sign\.outcome/);
  assert.match(preserveStep.run, /amo-signing-state\.mjs preserve-bundle/);
  assert.match(preserveStep.run, /\.amo-upload-provenance\.json/);

  const uploadStateStep = workflow.jobs.sign.steps.find(
    (step) => step.name === "Preserve available AMO upload state",
  );
  assert.equal(uploadStateStep.uses, "actions/upload-artifact@v4");
  assert.match(uploadStateStep.if, /always\(\)/);
  assert.equal(uploadStateStep.with["include-hidden-files"], true);
  assert.equal(uploadStateStep.with["if-no-files-found"], "warn");
  assert.ok(uploadStateStep.with["retention-days"] <= 7);
  assert.equal(uploadStateStep.with.overwrite, true);
  assert.match(uploadStateStep.with.name, /steps\.release\.outputs\.current_state_artifact/);
  assert.match(uploadStateStep.with.path, /browser2ide-amo-state/);

  const signIndex = workflow.jobs.sign.steps.indexOf(signStep);
  assert.ok(workflow.jobs.sign.steps.indexOf(preserveStep) > signIndex);
  assert.ok(workflow.jobs.sign.steps.indexOf(uploadStateStep) > signIndex);
  assert.match(source, /\^\[1-9\]\[0-9\]\*\$/);

  const runMetadataStep = workflow.jobs.sign.steps.find(
    (step) => step.name === "Fetch prior signing run metadata",
  );
  assert.ok(runMetadataStep);
  assert.match(runMetadataStep.if, /resume_run_id/);
  assert.match(runMetadataStep.run, /gh api/);
  assert.match(runMetadataStep.run, /actions\/runs\/\$\{RESUME_RUN_ID\}/);

  const validateResumeStep = workflow.jobs.sign.steps.find(
    (step) => step.name === "Validate restored AMO upload state and provenance",
  );
  assert.ok(validateResumeStep);
  assert.match(validateResumeStep.run, /validate-resume/);
  assert.match(validateResumeStep.run, /\.amo-upload-provenance\.json/);
  assert.match(validateResumeStep.run, /GITHUB_REPOSITORY/);
  assert.match(validateResumeStep.run, /\.github\/workflows\/firefox-sign\.yml/);
  assert.match(validateResumeStep.run, /workflow_dispatch/);
  assert.match(validateResumeStep.run, /RELEASE_COMMIT/);
  assert.match(validateResumeStep.run, /RESUME_RUN_ID/);

  const unsignedDownload = stepIndex(
    workflow.jobs.sign.steps,
    "Download unsigned draft for signing",
  );
  const unsignedVerify = stepIndex(
    workflow.jobs.sign.steps,
    "Verify unsigned draft identity before AMO",
  );
  assert.ok(unsignedDownload < unsignedVerify && unsignedVerify < signIndex);
  const unsignedVerifier = workflow.jobs.sign.steps[unsignedVerify];
  assert.match(unsignedVerifier.run, /verify-release-assets\.mjs unsigned/);
  assert.match(unsignedVerifier.run, /--compare-all/);
  assert.match(unsignedVerifier.run, /release_database_id/);

  const xpiVerify = stepIndex(
    workflow.jobs.sign.steps,
    "Normalize and verify the single signed artifact",
  );
  assert.ok(xpiVerify > signIndex);
  assert.match(
    workflow.jobs.sign.steps[xpiVerify].run,
    /verify-signed-firefox\.mjs/,
  );

  const preUploadDownload = stepIndex(
    workflow.jobs.sign.steps,
    "Redownload unsigned draft immediately before upload",
  );
  const preUploadVerify = stepIndex(
    workflow.jobs.sign.steps,
    "Revalidate unsigned draft immediately before upload",
  );
  const checksumIndex = stepIndex(
    workflow.jobs.sign.steps,
    "Regenerate signed checksums",
  );
  const uploadIndex = stepIndex(
    workflow.jobs.sign.steps,
    "Upload signed XPI to draft",
  );
  assert.ok(xpiVerify < checksumIndex && checksumIndex < preUploadDownload);
  assert.ok(preUploadDownload < preUploadVerify);
  assert.ok(preUploadVerify < uploadIndex);
  assert.match(
    workflow.jobs.sign.steps[preUploadVerify].run,
    /--expected-database-id/,
  );
  assert.match(workflow.jobs.sign.steps[preUploadVerify].run, /--compare-unsigned-artifacts/);
  assert.match(workflow.jobs.sign.steps[preUploadVerify].run, /cmp --/);

  const postUploadVerify = stepIndex(
    workflow.jobs.sign.steps,
    "Verify signed draft after upload",
  );
  assert.ok(postUploadVerify > uploadIndex);
  assert.match(
    workflow.jobs.sign.steps[postUploadVerify].run,
    /verify-release-assets\.mjs signed/,
  );
  assert.match(
    workflow.jobs.sign.steps[postUploadVerify].run,
    /--expected-database-id/,
  );

  const publishCapture = stepIndex(
    workflow.jobs.sign.steps,
    "Verify signed draft identity for publication",
  );
  const publishRedownload = stepIndex(
    workflow.jobs.sign.steps,
    "Redownload signed draft immediately before publication",
  );
  const publishRecheck = stepIndex(
    workflow.jobs.sign.steps,
    "Revalidate signed draft immediately before publication",
  );
  const publish = stepIndex(
    workflow.jobs.sign.steps,
    "Publish installed-verified release",
  );
  assert.ok(publishCapture < publishRedownload);
  assert.ok(publishRedownload < publishRecheck && publishRecheck < publish);
  assert.match(workflow.jobs.sign.steps[publishRecheck].run, /--expected-database-id/);
  assert.match(workflow.jobs.sign.steps[publishRecheck].run, /verify-release-assets\.mjs signed/);

  for (const name of [
    "Download unsigned draft for signing",
    "Redownload unsigned draft immediately before upload",
    "Download signed draft after upload",
    "Download signed draft for publication",
    "Redownload signed draft immediately before publication",
  ]) {
    assert.match(workflow.jobs.sign.steps[stepIndex(workflow.jobs.sign.steps, name)].run, /databaseId,isDraft,assets/);
  }

  assertGhTokenIsScopedToGhSteps(workflow.jobs.sign.steps);

  const verifyAssets = source.indexOf("verify-release-assets.mjs");
  const publishCommand = source.indexOf("--draft=false");
  assert.ok(verifyAssets >= 0 && publishCommand > verifyAssets);
});

test("release guide uses annotated alpha tags and documents repository protections", async () => {
  const source = await readFile(resolve(root, "docs/release.md"), "utf8");

  assert.match(source, /git tag -a v0\.2\.0/);
  assert.doesNotMatch(source, /git tag -s|git verify-tag/);
  assert.match(
    source,
    /cryptographic tag\s+signing is not configured for the `0\.2\.0` alpha/i,
  );
  assert.match(source, /branch protection|branch ruleset/i);
  assert.match(source, /tag protection|tag ruleset/i);
  assert.match(source, /protected GitHub Environment/i);
  assert.match(source, /recommended[^.]+not required|not required[^.]+recommended/i);
});

test("release guide limits stateful resume to post-validation failures", async () => {
  const source = await readFile(resolve(root, "docs/release.md"), "utf8");

  assert.match(source, /resume_run_id/);
  assert.match(source, /AMO Developer Hub/);
  assert.match(source, /\.amo-upload-uuid/);
  assert.match(source, /only after AMO validation succeeds/i);
  assert.match(source, /stateful resume[^.]+approval timeout/i);
  assert.match(source, /validation timeout[^.]+no state artifact/i);
  assert.match(source, /if-no-files-found[^.]+warn/i);
  assert.match(source, /write-checksums\.mjs/);
  assert.match(source, /new version[^.]+reject|reject[^.]+new version/i);
  assert.doesNotMatch(source, /validation (?:or|and) approval timeout/i);
  assert.match(
    source,
    /validation timeout occurs[^.]+do not use an\s+empty `resume_run_id`[^.]+do not submit again/i,
  );
  assert.doesNotMatch(source, /rerun mode `sign`/i);
  assert.doesNotMatch(source, /fresh (?:sign|submission|upload)/i);
});

test("manual fallback verifies the unsigned draft before changing release assets", async () => {
  const source = await readFile(resolve(root, "docs/release.md"), "utf8");
  const start = source.indexOf("### Recovery After Missing Or Expired State");
  const end = source.indexOf("## Verify Installed Artifacts", start);
  assert.ok(start >= 0 && end > start);
  const recovery = source.slice(start, end);

  const draftCheck = recovery.indexOf("gh release view");
  const download = recovery.indexOf("gh release download");
  const unsignedVerify = recovery.indexOf("verify-release-assets.mjs unsigned");
  const unsignedHashes = recovery.indexOf("sha256sum --check", unsignedVerify);
  const rename = recovery.indexOf("mv --");
  const xpiVerify = recovery.indexOf("verify-signed-firefox.mjs");
  const rewriteChecksums = recovery.indexOf("write-checksums.mjs");
  const upload = recovery.indexOf("gh release upload");
  const signedVerify = recovery.indexOf("verify-release-assets.mjs signed");
  const signedHashes = recovery.indexOf("sha256sum --check", signedVerify);
  const publish = recovery.indexOf("then use mode `publish`");

  assert.ok(draftCheck >= 0);
  assert.match(
    recovery,
    /test "\$\(gh release view "\$TAG" --json isDraft --jq '\.isDraft'\)" = "true"/,
  );
  assert.ok(download > draftCheck);
  assert.ok(unsignedVerify > download);
  assert.ok(unsignedHashes > unsignedVerify);
  assert.ok(xpiVerify > unsignedHashes);
  assert.ok(rename > xpiVerify);
  assert.ok(rewriteChecksums > rename);
  assert.ok(upload > rewriteChecksums);
  assert.ok(signedVerify > upload);
  assert.ok(signedHashes > signedVerify);
  assert.ok(publish > signedHashes);
  assert.match(recovery, /databaseId,isDraft,assets/);
  assert.match(recovery, /--expected-database-id/);
});

function stepIndex(steps, name) {
  const index = steps.findIndex((step) => step.name === name);
  assert.ok(index >= 0, `Missing workflow step: ${name}`);
  return index;
}

function assertGhTokenIsScopedToGhSteps(steps) {
  for (const step of steps) {
    if (!Object.hasOwn(step.env ?? {}, "GH_TOKEN")) continue;
    assert.match(step.run ?? "", /(?:^|\n)\s*gh\s/m, `${step.name} must invoke gh`);
    assert.doesNotMatch(
      step.run ?? "",
      /node\s+tools\/|corepack\s+pnpm|\bgit\s/,
      `${step.name} must not run repository code with GH_TOKEN`,
    );
  }
}
