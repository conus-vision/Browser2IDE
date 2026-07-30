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
  assert.match(source, /verify-release-version\.mjs/);
  assert.match(source, /git cat-file -t/);
  assert.match(source, /corepack pnpm package/);
  assert.match(source, /gh release create/);
  assert.match(source, /--draft/);
  assert.match(source, /artifacts\/SHA256SUMS/);
  assert.doesNotMatch(source, /run:[^\n]*\$\{\{ github\.ref_name \}\}/);
  assert.doesNotMatch(source, /AMO_JWT_(?:ISSUER|SECRET)/);
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
  assert.match(source, /refs\/tags\/\$RELEASE_TAG/);
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
  assert.match(signStep.run, /--approval-timeout=900000/);
  assert.match(signStep.run, /--timeout=900000/);
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
  assert.match(preserveStep.run, /amo-signing-state\.mjs preserve/);

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
  assert.match(uploadStateStep.with.path, /\.amo-upload-uuid/);

  const signIndex = workflow.jobs.sign.steps.indexOf(signStep);
  assert.ok(workflow.jobs.sign.steps.indexOf(preserveStep) > signIndex);
  assert.ok(workflow.jobs.sign.steps.indexOf(uploadStateStep) > signIndex);
  assert.match(source, /\^\[1-9\]\[0-9\]\*\$/);

  const verifyAssets = source.indexOf("verify-release-assets.mjs");
  const publish = source.indexOf("--draft=false");
  assert.ok(verifyAssets >= 0 && publish > verifyAssets);
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
  assert.ok(rename > unsignedHashes);
  assert.ok(rewriteChecksums > rename);
  assert.ok(upload > rewriteChecksums);
  assert.ok(signedVerify > upload);
  assert.ok(signedHashes > signedVerify);
  assert.ok(publish > signedHashes);
});
