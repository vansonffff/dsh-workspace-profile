/**
 * Packaging contract: the four names that must agree, and the exports the loader
 * resolves.
 *
 * These are cheap static checks for failures that are expensive to diagnose at
 * runtime. A package whose client registration id differs from its loader row
 * `name` fails as `bundle <url> loaded without registering "<id>"`, with no hint
 * about which of the two is wrong; two loader rows for one package fail as a
 * `logger.warn` and an invisible panel.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('..', import.meta.url);
const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, ROOT), 'utf8'));
const readText = async (relative) => readFile(new URL(relative, ROOT), 'utf8');

const PACKAGE_NAME = 'dsh-workspace-profile';

test('package.json declares the bundle patch and a web client half', async () => {
  const manifest = await readJson('package.json');
  assert.equal(manifest.name, PACKAGE_NAME);
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.dsh.bundle, { patch: './cordis.patch.yml' });
  assert.equal(manifest.dsh.client.platform, 'web');
  // The loader resolves the browser bundle through this export; without it the
  // package is mounted but has no client half at all.
  assert.ok(manifest.exports['./client'], 'exports["./client"] is mandatory');
  assert.ok(manifest.exports['.'], 'the host half needs a "." export');
  // `dsh-typert-loader` discovers the Remote manifest through this export.
  assert.ok(manifest.exports['./typert'], 'exports["./typert"] is how the Remote is discovered');
});

test('the loader row name, the package name and the client registration id agree', async () => {
  const patch = await readText('cordis.patch.yml');
  const names = [...patch.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(names, [PACKAGE_NAME], 'exactly one row, named after the package');

  const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  assert.equal(ids.length, 1, 'exactly one row id');

  const client = await readText('client.js');
  const registration = /window\.__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(client);
  assert.ok(registration !== null, 'client.js must register through __ModuleLoader__.load');
  // The loader compares this id against `entry.options.name`.
  assert.equal(registration[1], PACKAGE_NAME);
});

test('every bare import in src/ resolves through a linked dependency', async () => {
  const files = [
    'src/index.js',
    'src/settings.js',
    'src/policy.js',
    'src/errors.js',
    'src/model-catalog.js',
    'src/workspace-resolution.js',
    'src/profile-runtime.js',
    'src/skill-policy.js',
    'src/subagent-registry.js',
    'src/subagent-dispatch.js',
    'src/tools.js',
    'src/commands.js',
    'src/service.js',
    'src/instructions-probe.js',
    'src/remote/invocations.js',
    'src/remote/operations.js',
    'src/remote/schemas.js',
    'typert.host.js',
    'typert.remote-client.js',
  ];
  const bare = new Set();
  for (const file of files) {
    const source = await readText(file);
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      bare.add(specifier);
    }
  }
  // `npm` is unusable on this machine (a broken ~/.npm ownership), so a missing
  // dependency cannot be found by installing — only by resolving it here.
  for (const specifier of bare) {
    await assert.doesNotReject(() => import(specifier), `cannot resolve ${specifier}`);
  }
  assert.ok(bare.size > 0);
});

test('the client bundle requires nothing beyond the platform seed', async () => {
  const client = await readText('client.js');
  const required = [...client.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  const allowed = new Set(['react', 'react/jsx-runtime']);
  for (const specifier of required) {
    assert.ok(allowed.has(specifier), `client.js must not require "${specifier}"`);
  }
  // `require` is synchronous and resolves seed → cache → registered factory →
  // throw, so an undeclared dependency is a hard failure at first render.
  assert.deepEqual([...new Set(required)].sort(), ['react', 'react/jsx-runtime']);
});

test('the package ships the files its exports point at', async () => {
  const manifest = await readJson('package.json');
  for (const entry of [manifest.main, manifest.exports['./typert'].default, manifest.exports['./remote-client'].default, manifest.exports['./client'].default]) {
    const file = entry.replace(/^\.\//, '');
    await assert.doesNotReject(() => readFile(new URL(file, ROOT)), `${file} is missing`);
  }
  for (const directory of ['profiles', 'perspectives']) {
    assert.ok(manifest.files.includes(directory), `${directory} must be shipped: the Profile bodies are read at runtime`);
  }
  await assert.doesNotReject(() => readFile(new URL('profiles/bankruptcy.md', ROOT)));
});
