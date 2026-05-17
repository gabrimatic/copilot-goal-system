import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const pagesUrl = "https://gabrimatic.github.io/copilot-goal-system/";

test("Mintlify docs live in doc and legacy docs source is gone", () => {
  assert.equal(existsSync(path.join(root, "docs")), false);

  for (const file of [
    "doc/docs.json",
    "doc/index.mdx",
    "doc/quickstart.mdx",
    "doc/reference/installation.mdx",
    "doc/reference/architecture.mdx",
    "doc/reference/requirements.mdx",
    "doc/product/vscode-chat.mdx",
    "doc/product/portability.mdx",
    "doc/operations/local-verification.mdx",
    "doc/operations/runtime-e2e-review.mdx",
    "doc/scripts/prepare-github-pages.mjs"
  ]) {
    assert.equal(existsSync(path.join(root, file)), true, `${file} should exist`);
  }
});

test("README points readers to the published Pages docs", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");

  assert.match(readme, new RegExp(pagesUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(readme, /\]\(docs\//);
  assert.doesNotMatch(readme, /\]\(doc\//);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com\/gabrimatic\/copilot-goal-system\/[^)\s]+\/install\.sh/);
  assert.doesNotMatch(readme, /\bdoc\//);
  assert.doesNotMatch(readme, /`docs\/`/);
  assert.doesNotMatch(readme, /internal-docs/);
});

test("Docs Pages workflow owns docs deploys and full CI ignores docs-only changes", async () => {
  const docsWorkflow = await readFile(path.join(root, ".github/workflows/docs-pages.yml"), "utf8");
  const ciWorkflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const prepareBundle = await readFile(path.join(root, "vscode-extension/scripts/prepare-bundle.mjs"), "utf8");

  assert.match(docsWorkflow, /doc\/\*\*/);
  assert.match(docsWorkflow, /README\.md/);
  assert.match(docsWorkflow, /install\.sh/);
  assert.match(docsWorkflow, /mint validate/);
  assert.match(docsWorkflow, /mint broken-links/);
  assert.match(docsWorkflow, /mint export/);
  assert.match(docsWorkflow, /actions\/deploy-pages/);
  assert.match(docsWorkflow, /if: \$\{\{ github\.event_name != 'pull_request' \}\}/);

  for (const ignoredPath of [
    "doc/**",
    "README.md",
    ".github/workflows/docs-pages.yml",
    "tests/docs-site.test.mjs",
    "install.sh"
  ]) {
    assert.match(ciWorkflow, new RegExp(ignoredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(prepareBundle, /"doc"/);
  assert.doesNotMatch(prepareBundle, /"docs"/);
});
