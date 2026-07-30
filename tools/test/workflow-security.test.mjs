import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "../..");
const workflows = ["ci.yml", "release.yml", "firefox-sign.yml"];
const actionPins = new Map([
  ["actions/checkout", ["3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"]],
  ["actions/setup-node", ["820762786026740c76f36085b0efc47a31fe5020", "v7.0.0"]],
  ["actions/upload-artifact", ["043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "v7.0.1"]],
  ["actions/download-artifact", ["3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", "v8.0.1"]],
  ["pnpm/action-setup", ["0ebf47130e4866e96fce0953f49152a61190b271", "v6.0.9"]],
]);

test("all third-party Actions are pinned to reviewed full commit SHAs", async () => {
  for (const filename of workflows) {
    const source = await readFile(resolve(root, ".github/workflows", filename), "utf8");
    for (const line of source.split("\n")) {
      const match = /^\s*uses:\s*([^@\s]+)@([^\s#]+)(?:\s+#\s*(\S+))?\s*$/.exec(line);
      if (!match) continue;
      const expected = actionPins.get(match[1]);
      assert.ok(expected, `${filename} uses an unreviewed action: ${match[1]}`);
      assert.equal(match[2], expected[0], `${filename}: ${match[1]} must use the reviewed SHA`);
      assert.equal(match[3], expected[1], `${filename}: ${match[1]} must name the reviewed version`);
    }
    assert.doesNotMatch(source, /uses:\s*[^\s]+@(?![0-9a-f]{40}(?:\s|#|$))/);
  }
});

test("CI has read-only permissions and checkout never persists credentials", async () => {
  const workflow = await readWorkflow("ci.yml");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.verify.permissions, undefined);
  assertPersistCredentialsDisabled(workflow.jobs.verify.steps);
});

test("draft release separates read-only packaging from minimal release mutation", async () => {
  const workflow = await readWorkflow("release.yml");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.package.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.create_draft.permissions, {
    actions: "read",
    contents: "write",
  });
  assert.equal(workflow.jobs.create_draft.needs, "package");
  assertPersistCredentialsDisabled(workflow.jobs.package.steps);
  assert.equal(
    workflow.jobs.create_draft.steps.some((step) => step.uses?.startsWith("actions/checkout@")),
    false,
  );
  assert.ok(
    workflow.jobs.package.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")),
  );
  assert.ok(
    workflow.jobs.create_draft.steps.some((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    ),
  );
  assertNoRepositoryCodeWithGhToken(workflow.jobs.create_draft.steps);
});

test("Firefox signing isolates AMO secrets and protects every privileged job", async () => {
  const workflow = await readWorkflow("firefox-sign.yml");
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.validate.permissions, {
    actions: "read",
    contents: "read",
  });
  assert.deepEqual(workflow.jobs.sign.permissions, {
    actions: "read",
    contents: "read",
  });
  assert.deepEqual(workflow.jobs.attach.permissions, {
    actions: "read",
    contents: "write",
  });
  assert.deepEqual(workflow.jobs.publish.permissions, {
    actions: "read",
    contents: "write",
  });

  for (const name of ["sign", "attach", "publish"]) {
    assert.equal(workflow.jobs[name].environment, "amo-signing");
    assert.match(workflow.jobs[name].if, /github\.ref == 'refs\/heads\/master'/);
  }
  const trustedContextGate = workflow.jobs.validate.steps.find(
    (step) => step.name === "Require mode-specific trusted inputs",
  );
  assert.match(trustedContextGate.run, /GITHUB_EVENT_NAME.*workflow_dispatch/s);
  assert.match(trustedContextGate.run, /GITHUB_REF.*refs\/heads\/master/s);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.attach), /AMO_JWT_/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.publish), /AMO_JWT_/);
  assert.equal(workflow.jobs.sign.permissions.contents, "read");

  for (const name of ["attach", "publish"]) {
    const actionSteps = workflow.jobs[name].steps.filter((step) => step.uses);
    assert.ok(actionSteps.length > 0);
    assert.ok(
      actionSteps.every((step) => step.uses.startsWith("actions/download-artifact@")),
      `${name} may only retrieve pinned artifacts`,
    );
  }

  const secretSteps = workflow.jobs.sign.steps.filter((step) =>
    Object.values(step.env ?? {}).some((value) => String(value).includes("secrets.AMO_JWT_")),
  );
  assert.equal(secretSteps.length, 1);
  assert.match(secretSteps[0].run, /web-ext sign/);
  assertNoRepositoryCodeWithGhToken(workflow.jobs.attach.steps);
  assertNoRepositoryCodeWithGhToken(workflow.jobs.publish.steps);
});

test("Firefox publish requires exact sign-run provenance and manually verified XPI digest", async () => {
  const source = await readFile(resolve(root, ".github/workflows/firefox-sign.yml"), "utf8");
  const workflow = YAML.parse(source);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.sign_run_id.type, "string");
  assert.equal(inputs.verified_xpi_sha256.type, "string");
  assert.match(inputs.sign_run_id.description, /publish/i);
  assert.match(inputs.verified_xpi_sha256.description, /Firefox Stable/i);

  const gate = workflow.jobs.validate.steps.find(
    (step) => step.name === "Require mode-specific trusted inputs",
  );
  assert.match(gate.run, /MODE.*publish/s);
  assert.match(gate.run, /SIGN_RUN_ID/);
  assert.match(gate.run, /VERIFIED_XPI_SHA256/);
  assert.match(gate.run, /\^\[0-9a-f\]\{64\}\$/);

  const publishSteps = workflow.jobs.publish.steps;
  const fetchRun = stepIndex(publishSteps, "Fetch trusted signing run metadata");
  const restore = stepIndex(publishSteps, "Restore immutable signed XPI provenance");
  const validate = stepIndex(publishSteps, "Validate exact manually verified signed XPI");
  const firstRelease = stepIndex(publishSteps, "Download signed draft for publication");
  const finalRelease = stepIndex(
    publishSteps,
    "Redownload signed draft immediately before publication",
  );
  const publish = stepIndex(publishSteps, "Publish installed-verified release");
  assert.ok(fetchRun < restore && restore < validate && validate < firstRelease);
  assert.ok(firstRelease < finalRelease && finalRelease < publish);
  assert.equal(publishSteps[restore].with["run-id"], "${{ inputs.sign_run_id }}");
  assert.match(publishSteps[restore].with.name, /inputs\.tag/);
  assert.match(publishSteps[restore].with.name, /inputs\.sign_run_id/);
  assert.match(publishSteps[validate].run, /release-signing-provenance\.mjs validate-publish/);
  assert.match(publishSteps[validate].run, /VERIFIED_XPI_SHA256/);
  assert.match(publishSteps[validate].run, /SIGN_RUN_ID/);
  assert.match(publishSteps[finalRelease + 1].run, /verify-release-assets\.mjs signed/);
  assert.match(publishSteps[finalRelease + 1].run, /cmp --/);
  assert.match(publishSteps[publish].run, /--draft=false/);

  const provenanceUpload = workflow.jobs.sign.steps.find(
    (step) => step.name === "Preserve immutable signed XPI provenance",
  );
  assert.ok(provenanceUpload.uses.startsWith("actions/upload-artifact@"));
  assert.equal(provenanceUpload.with.overwrite, undefined);
  assert.ok(provenanceUpload.with["retention-days"] >= 30);
  assert.match(provenanceUpload.with.name, /steps\.provenance\.outputs\.artifact_name/);
  const createProvenance = workflow.jobs.sign.steps.find(
    (step) => step.name === "Create immutable signed XPI provenance",
  );
  assert.match(createProvenance.run, /artifact-name/);
  assert.match(createProvenance.env.CURRENT_RUN_ID, /github\.run_id/);
});

test("release guide makes the protected AMO environment and digest handoff mandatory", async () => {
  const source = await readFile(resolve(root, "docs/release.md"), "utf8");
  const environment = source.slice(0, source.indexOf("## Prepare A Release"));
  assert.match(environment, /`amo-signing`/);
  assert.match(environment, /protected branch/i);
  assert.match(environment, /required reviewer/i);
  assert.match(environment, /disabled self-review|prevent self-review/i);
  assert.match(environment, /before[^.]+AMO_JWT_ISSUER/i);
  assert.doesNotMatch(environment, /optional|not required/i);
  assert.match(source, /sign_run_id/);
  assert.match(source, /verified_xpi_sha256/);
  assert.match(source, /Firefox Stable/i);
  assert.match(source, /does not cryptographically verify Mozilla/i);
  assert.match(source, /active document/i);
  assert.doesNotMatch(source, /CSS\/SCSS source opening/i);
});

async function readWorkflow(filename) {
  return YAML.parse(
    await readFile(resolve(root, ".github/workflows", filename), "utf8"),
  );
}

function assertPersistCredentialsDisabled(steps) {
  const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkouts.length > 0);
  for (const checkout of checkouts) {
    assert.equal(checkout.with?.["persist-credentials"], false);
  }
}

function assertNoRepositoryCodeWithGhToken(steps) {
  for (const step of steps) {
    if (!Object.hasOwn(step.env ?? {}, "GH_TOKEN")) continue;
    assert.match(step.run ?? "", /(?:^|\n)\s*gh\s/m);
    assert.doesNotMatch(step.run ?? "", /node\s+|corepack\s+pnpm|\bgit\s/);
  }
}

function stepIndex(steps, name) {
  const index = steps.findIndex((step) => step.name === name);
  assert.ok(index >= 0, `Missing workflow step: ${name}`);
  return index;
}
