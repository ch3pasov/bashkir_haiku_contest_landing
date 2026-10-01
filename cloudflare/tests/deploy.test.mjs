import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const deploymentScript = new URL('../scripts/deploy.mjs', import.meta.url).pathname;
const version = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const previous = [
  { version_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', percentage: 80 },
  { version_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', percentage: 20 },
];

function execute(mode) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'cloudflare-ci-offline-'));
  try {
    mkdirSync(path.join(cwd, 'node_modules/wrangler/bin'), { recursive: true });
    mkdirSync(path.join(cwd, 'public/files'), { recursive: true });
    writeFileSync(path.join(cwd, 'public/index.html'), '<!doctype html><html><body>original</body></html>');
    writeFileSync(path.join(cwd, 'public/files/model.glb'), Buffer.from([0, 255, 12, 15]));
    writeFileSync(path.join(cwd, 'public/_headers'), 'ignored');
    writeFileSync(path.join(cwd, 'ci.json'), JSON.stringify({ worker_name: 'fixture-worker', account_id: 'fixture-account', repository: 'fixture/site', production_url: 'https://fixture.example', worker_dev_url: 'https://fixture.workers.dev' }));
    writeFileSync(path.join(cwd, 'wrangler.json'), JSON.stringify({ name: 'fixture-worker', account_id: 'fixture-account', assets: { directory: './public' } }));
    writeFileSync(path.join(cwd, 'state.json'), JSON.stringify({ calls: [], versions: previous, requests: [] }));
    writeFileSync(path.join(cwd, 'node_modules/wrangler/bin/wrangler.js'), `
      const fs = require('node:fs');
      const state = JSON.parse(fs.readFileSync('state.json'));
      const args = process.argv.slice(2);
      state.calls.push(args);
      fs.writeFileSync('state.json', JSON.stringify(state));
      if (args[1] === 'upload') {
        if (process.env.FIXTURE_MODE === 'upload-failure') process.exit(1);
        fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({type: 'version-upload', worker_name: 'fixture-worker', version_id: '${version}'}) + '\\n');
      } else {
        const activatingNewVersion = args.includes('${version}@100%');
        if (activatingNewVersion && process.env.FIXTURE_MODE === 'deploy-failure-before') process.exit(1);
        state.versions = args.slice(2).filter(arg => /^[a-f0-9-]+@\\d+%$/.test(arg)).map(arg => {
          const [version_id, percentage] = arg.split('@');
          return {version_id, percentage: Number(percentage.slice(0, -1))};
        });
        fs.writeFileSync('state.json', JSON.stringify(state));
        if (activatingNewVersion && process.env.FIXTURE_MODE === 'deploy-failure-after') process.exit(1);
      }
    `);
    writeFileSync(path.join(cwd, 'preload.mjs'), `
      import {readFileSync, writeFileSync} from 'node:fs';
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 5000 ? 0 : delay, ...args);
      globalThis.fetch = async (url, options = {}) => {
        const state = JSON.parse(readFileSync('state.json'));
        const u = new URL(url);
        state.requests.push({url: u.href, method: options.method ?? 'GET'});
        writeFileSync('state.json', JSON.stringify(state));
        if (u.host === 'api.cloudflare.com') {
          if (options.headers.Authorization !== 'Bearer synthetic-offline-only') throw Error('wrong synthetic auth');
          if (u.pathname.endsWith('/domains')) return Response.json({success:true, result:[{hostname:'fixture.example', service:process.env.FIXTURE_MODE === 'wrong-domain' ? 'other-worker' : 'fixture-worker', environment:'production'}]});
          if (!u.pathname.endsWith('/deployments')) throw Error('unexpected API endpoint');
          return Response.json({success: true, result: {deployments: [{versions: state.versions}]}});
        }
        if (!['fixture.workers.dev', 'fixture.example'].includes(u.host)) throw Error('network forbidden');
        if (u.host === 'fixture.example' && ['challenge', 'ordinary-forbidden'].includes(process.env.FIXTURE_MODE)) return new Response('forbidden', {status:403, headers:process.env.FIXTURE_MODE === 'challenge' ? {'cf-mitigated':'challenge','cf-ray':'fixture-ray'} : {}});
        if (u.pathname.includes('nonexistent-ci-check')) return new Response('missing', {status:404});
        if (process.env.FIXTURE_MODE === 'verification-failure' && u.host === 'fixture.example') return new Response('broken');
        const name = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
        let bytes = readFileSync('public/' + name);
        if (u.host === 'fixture.example') {
          const injection = '<a href="https://fixture.example/cdn-cgi/content?id=fixture" aria-hidden="true" rel="nofollow noopener" style="display: none !important; visibility: hidden !important"></a>' +
            "<script>(function(){function c(){var b=a.contentDocument;window.__CF$cv$params={};a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';}})();</script>";
          bytes = Buffer.from(bytes.toString().replace('</body>', injection + '</body>'));
        }
        return new Response(bytes, {headers:{'content-type':name.endsWith('.glb') ? 'model/gltf-binary' : 'text/html'}});
      };
    `);
    const result = spawnSync(process.execPath, [deploymentScript], {
      cwd, encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: 'synthetic-offline-only', FIXTURE_MODE: mode,
        NODE_OPTIONS: '--import=' + path.join(cwd, 'preload.mjs'),
        GITHUB_REPOSITORY: 'fixture/site', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'fixture-commit' },
    });
    assert(existsSync(path.join(cwd, 'deployment.json')), result.stderr);
    return { result, state: JSON.parse(readFileSync(path.join(cwd, 'state.json'))), report: JSON.parse(readFileSync(path.join(cwd, 'deployment.json'))) };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test('structured upload publishes exactly 100%, verifies binary assets and normalizes production Cloudflare injections', () => {
  const {result, state, report} = execute('success');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, 'verified');
  assert.equal(report.version_id, version);
  assert.equal(report.assets.length, 2);
  assert.deepEqual(state.calls.map(call => call.slice(0, 2)), [['versions','upload'], ['versions','deploy']]);
  assert(state.calls[0].includes('--keep-vars'));
  assert(state.calls[1].includes(version + '@100%'));
  assert.deepEqual(state.versions, [{version_id:version, percentage:100}]);
  assert(state.requests.every(r => r.method === 'GET'));
  assert(!state.requests.some(r => /\/dns_records|\/routes/.test(r.url)));
  assert.equal(report.domain_binding_verified, true);
});

test('failed upload never deploys and retains the previous production split', () => {
  const {result, state, report} = execute('upload-failure');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Wrangler versions upload failed/);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.versions, previous);
  assert.deepEqual(report.previous_versions, previous);
});

test('persistent verification mismatch restores both previous versions and their percentages', () => {
  const {result, state, report} = execute('verification-failure');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous deployment restored/);
  assert.equal(report.status, 'rolled_back');
  assert.match(report.verification_error, /Production page differs/);
  assert.equal(state.calls.length, 3);
  assert(state.calls[2].includes(previous[0].version_id + '@80%'));
  assert(state.calls[2].includes(previous[1].version_id + '@20%'));
  assert.deepEqual(state.versions, previous);
});

test('CLI failure after Cloudflare accepts the new version restores the previous traffic split', () => {
  const {result, state, report} = execute('deploy-failure-after');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous deployment restored/);
  assert.equal(report.status, 'rolled_back');
  assert.match(report.verification_error, /Wrangler versions deploy failed/);
  assert.equal(state.calls.length, 3);
  assert.deepEqual(state.versions, previous);
});

test('CLI failure before activation leaves existing deployment and avoids redundant rollback', () => {
  const {result, state, report} = execute('deploy-failure-before');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous deployment remains active/);
  assert.equal(report.status, 'failed_before_activation');
  assert.match(report.verification_error, /Wrangler versions deploy failed/);
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.versions, previous);
});


test('documented Cloudflare challenge preserves security and verifies origin files plus production binding', () => {
  const {result, state, report} = execute('challenge');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, 'verified');
  assert.equal(report.production_check.status, 'cloudflare_challenge');
  assert.equal(report.domain_binding_verified, true);
  assert.equal(report.assets.length, 2);
  assert(state.requests.some(r => r.url === 'https://fixture.workers.dev/nonexistent-ci-check-7283'));
  assert.equal(state.calls.length, 2);
});

test('ordinary production 403 without challenge marker rolls back', () => {
  const {result, state, report} = execute('ordinary-forbidden');
  assert.notEqual(result.status, 0);
  assert.equal(report.status, 'rolled_back');
  assert.deepEqual(state.versions, previous);
});

test('production domain bound to another Worker causes rollback', () => {
  const {result, state, report} = execute('wrong-domain');
  assert.notEqual(result.status, 0);
  assert.equal(report.status, 'rolled_back');
  assert.match(report.verification_error, /Production domain is not bound/);
  assert.deepEqual(state.versions, previous);
});
