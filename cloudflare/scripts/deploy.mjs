import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ci = JSON.parse(readFileSync("ci.json"));
const config = JSON.parse(readFileSync("wrangler.json"));
assert.equal(config.name, ci.worker_name);
assert.equal(config.account_id, ci.account_id);
if (process.env.GITHUB_REPOSITORY) {
  assert.equal(process.env.GITHUB_REPOSITORY, ci.repository);
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.notEqual(process.env.GITHUB_EVENT_NAME, "pull_request");
}
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (!token) throw new Error("Add the dedicated CLOUDFLARE_API_TOKEN in this repository's Actions secrets.");
const commit = process.env.GITHUB_SHA ?? "manual";
const directory = mkdtempSync(path.join(os.tmpdir(), "cloudflare-publish-"));
const outputFile = path.join(directory, "output.jsonl");
const prefix = `/accounts/${ci.account_id}/workers/scripts/${ci.worker_name}`;
const env = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: directory, WRANGLER_OUTPUT_FILE_PATH: outputFile };
const wrangler = path.resolve("node_modules/wrangler/bin/wrangler.js");
const report = { repository: ci.repository, commit_sha: commit, worker: ci.worker_name,
  production_url: ci.production_url, started_at: new Date().toISOString(),
  status: "started", modifies_dns: false, modifies_vps: false };
const save = () => writeFileSync("deployment.json", JSON.stringify(report, null, 2) + "\n");

async function api(endpoint) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + endpoint, {
    headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(`Cloudflare read failed: ${endpoint} (${response.status})`);
  return body.result;
}
function run(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  for (const output of [result.stdout, result.stderr]) {
    if (output) process.stdout.write(output.replaceAll(token, "[REDACTED]"));
  }
  if (result.error || result.status !== 0) throw new Error(`Wrangler ${args.slice(0, 2).join(" ")} failed`);
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function response(url, options = {}) {
  return fetch(url, { redirect: "manual", headers: { "User-Agent": "curl/8.5.0" },
    signal: AbortSignal.timeout(30000), ...options });
}
function files(directory, relative = "") {
  return readdirSync(directory).sort().flatMap(name => {
    if (name === "_headers" || name === ".DS_Store") return [];
    const filename = path.join(directory, name), resource = relative + "/" + name;
    return statSync(filename).isDirectory() ? files(filename, resource) : [{ filename, resource }];
  });
}
function removeCloudflareProtection(bytes) {
  return Buffer.from(bytes.toString("utf8")
    .replace(/<a href="https:\/\/[^"<>]+\/cdn-cgi\/content\?id=[^"<>]+" aria-hidden="true" rel="nofollow noopener" style="display: none !important; visibility: hidden !important"><\/a>/g, "")
    .replace(/<script>\(function\(\)\{function c\(\)\{var b=a\.contentDocument[^<]*?<\/script>/g, script => {
      assert(script.length < 2500 && script.includes("window.__CF$cv$params=") &&
        script.includes("a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'"));
      return "";
    }));
}
async function verifyPublishedVersion(version) {
  const domains = await api(`/accounts/${ci.account_id}/workers/domains`);
  assert(domains.some(d => d.hostname === new URL(ci.production_url).hostname &&
    d.service === ci.worker_name && d.environment === "production"), "Production domain is not bound to this Worker");
  report.domain_binding_verified = true;
  const deployments = await api(prefix + "/deployments");
  assert(deployments.deployments[0].versions.some(v => v.version_id === version && v.percentage === 100));
  const root = ci.telegram_subscription ? path.resolve("../html") : path.resolve(config.assets.directory);
  const tasks = files(root);
  let next = 0;
  const checks = [];
  await Promise.all(Array.from({ length: Math.min(tasks.length, 6) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      const resource = task.resource.endsWith("/index.html") ? task.resource.slice(0, -"index.html".length) : task.resource;
      const url = ci.worker_dev_url + resource.split("/").map(encodeURIComponent).join("/");
      const result = await response(url);
      assert.equal(result.status, 200, resource);
      const bytes = Buffer.from(await result.arrayBuffer());
      const expected = readFileSync(task.filename);
      assert.equal(hash(bytes), hash(expected), "Published bytes differ: " + resource);
      if (resource.endsWith(".glb")) assert(result.headers.get("content-type").startsWith("model/gltf-binary"));
      if (resource.endsWith(".usdz")) assert(result.headers.get("content-type").startsWith("model/vnd.usdz+zip"));
      checks.push({ path: resource, sha256: hash(bytes) });
    }
  }));
  const live = await response(ci.production_url + "/");
  // Cloudflare challenges datacenter IPs before the request reaches the Worker.
  // Accept only its documented challenge marker, never an ordinary 403 error.
  const challenged = live.status === 403 && live.headers.get("cf-mitigated") === "challenge";
  report.production_check = { status: challenged ? "cloudflare_challenge" : "checked",
    http_status: live.status, cf_ray: live.headers.get("cf-ray") };
  if (challenged) {
    console.log("Cloudflare challenged the GitHub runner; all original files verified through workers.dev and the production domain binding verified via Cloudflare API.");
    await live.arrayBuffer();
  } else {
    assert.equal(live.status, 200, `Production domain (cf-mitigated=${live.headers.get("cf-mitigated")})`);
    const liveBody = Buffer.from(await live.arrayBuffer());
    const expected = readFileSync(path.join(root, "index.html"));
    assert.equal(hash(removeCloudflareProtection(liveBody)), hash(expected), "Production page differs");
  }
  const checkOrigin = challenged ? ci.worker_dev_url : ci.production_url;
  const missing = await response(checkOrigin + "/nonexistent-ci-check-7283");
  assert.equal(missing.status, 404);
  if (ci.telegram_subscription) {
    const health = await response(checkOrigin + "/healthz");
    assert.equal(health.status, 200);
    const body = await health.json();
    assert(body.ok && body.subscription_configured, "Telegram secret is not configured");
    const secrets = await api(prefix + "/secrets");
    assert(secrets.some(s => s.name === "TELEGRAM_CHECKER_BOT_TOKEN" && s.type === "secret_text"));
  }
  return checks;
}

try {
  // The dedicated Editor token updates only versions: no routes/DNS APIs or trigger deploys.
  const current = await api(prefix + "/deployments");
  assert(current.deployments.length > 0, "Worker must already exist");
  report.previous_versions = current.deployments[0].versions;
  save();
  run(["versions", "upload", "--keep-vars", "--message", `GitHub ${ci.repository}@${commit}`]);
  const records = readFileSync(outputFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const uploaded = records.filter(r => r.type === "version-upload");
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].worker_name, ci.worker_name);
  const version = uploaded[0].version_id;
  assert.match(version, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  report.version_id = version;
  report.status = "uploaded";
  save();
  try {
    run(["versions", "deploy", `${version}@100%`, "--yes", "--message", `GitHub ${commit}`]);
    report.status = "published";
    save();
    let error;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        report.assets = await verifyPublishedVersion(version);
        error = null;
        break;
      } catch (failure) { error = failure; }
    }
    if (error) throw error;
  } catch (failure) {
    report.verification_error = failure.message.replaceAll(token, "[REDACTED]");
    // CLI failures can occur after Cloudflare accepts a deployment. Read the
    // actual state and restore the saved traffic split whenever it changed.
    let unchanged = false;
    try {
      const state = await api(prefix + "/deployments");
      const normalize = versions => JSON.stringify(versions.map(v =>
        [v.version_id, v.percentage]).sort(([a], [b]) => a.localeCompare(b)));
      unchanged = normalize(state.deployments[0].versions) === normalize(report.previous_versions);
    } catch { /* If the read fails, attempt to restore the known previous state. */ }
    if (unchanged) {
      report.status = "failed_before_activation";
      save();
      throw new Error("Publication failed; previous deployment remains active.");
    }
    report.status = "rolling_back";
    save();
    try {
      run(["versions", "deploy", ...report.previous_versions.map(v => `${v.version_id}@${v.percentage}%`),
        "--yes", "--message", "Restore previous deployment after failed GitHub verification"]);
    } catch {
      report.status = "rollback_failed";
      save();
      throw new Error("Publication verification and automatic rollback failed; inspect Cloudflare Deployments.");
    }
    report.status = "rolled_back";
    save();
    throw new Error("Published version failed verification; previous deployment restored.");
  }
  report.status = "verified";
  report.verified_at = new Date().toISOString();
  save();
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Published ${ci.production_url}\n\nCommit: ${commit}\n\nVersion: ${version}\n\n` +
      `Verified ${report.assets.length} original files. Production check: ${report.production_check.status}. ` +
      `Production domain binding verified through Cloudflare API. Previous versions: ` +
      report.previous_versions.map(v => `${v.version_id} (${v.percentage}%)`).join(", ") + "\n",
      { flag: "a" });
  }
  console.log(`Verified ${ci.production_url}: ${version}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
