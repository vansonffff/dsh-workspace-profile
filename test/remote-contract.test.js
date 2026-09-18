/**
 * Remote contract: the two descriptor faces agree, and the service implements
 * exactly what the descriptors promise.
 *
 * The Gateway reads a Remote member's **source text** and rejects a parameter
 * that is not a plain identifier, and it checks the declared parameter count
 * against the descriptor. Both rules are static properties of this package, so
 * both are checked here rather than discovered at the first browser call.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  REMOTE_INVOCATIONS,
  WORKSPACE_PROFILE_NAMESPACE,
  WORKSPACE_PROFILE_PACKAGE,
  buildRemoteDescriptors,
} from '../src/remote/invocations.js';
import { buildClientDescriptors } from '../typert.remote-client.js';
import { WorkspaceProfileService } from '../src/service.js';

const passthrough = () => ({ mode: 'strict', parse: (value) => value });

test('the host and client descriptor tables are deeply equal', () => {
  const shape = (descriptors) =>
    descriptors.map((descriptor) => ({
      id: descriptor.id,
      service: descriptor.service,
      namespace: descriptor.namespace,
      method: descriptor.method,
      implementation: descriptor.implementation,
      invocation: descriptor.invocation,
      parameters: descriptor.parameters.map((parameter) => ({
        name: parameter.name,
        wire: parameter.wire,
        source: parameter.source,
        acceptsUndefined: parameter.acceptsUndefined,
      })),
      cancellation: descriptor.cancellation,
    }));
  const host = shape(buildRemoteDescriptors({ parameterSchema: passthrough, valueSchema: passthrough }));
  const client = shape(buildClientDescriptors(passthrough));
  // The client bundle cannot import the shared table, so it carries a copy; this
  // assertion is the only reason that duplication is acceptable.
  assert.deepEqual(client, host);
  assert.ok(host.length >= 8);
});

test('the descriptor identifiers are derived, never restated', () => {
  const descriptors = buildRemoteDescriptors({ parameterSchema: passthrough, valueSchema: passthrough });
  for (const descriptor of descriptors) {
    assert.equal(descriptor.service, WORKSPACE_PROFILE_NAMESPACE);
    assert.equal(descriptor.namespace, WORKSPACE_PROFILE_NAMESPACE);
    assert.equal(descriptor.id, `${WORKSPACE_PROFILE_PACKAGE}#${WORKSPACE_PROFILE_NAMESPACE}/${descriptor.method}`);
  }
});

test('every implementation exists and its arity matches the descriptor', () => {
  for (const invocation of REMOTE_INVOCATIONS) {
    const implementation = WorkspaceProfileService.prototype[invocation.implementation];
    assert.equal(typeof implementation, 'function', `${invocation.implementation} must exist on the service`);
    const expected = invocation.parameters.length + (invocation.cancellable === true ? 1 : 0);
    assert.equal(
      implementation.length,
      expected,
      `${invocation.implementation} declares ${implementation.length} parameters but the descriptor says ${expected}`,
    );
  }
});

test('every implementation parameter is a plain identifier', () => {
  // The Gateway parses the source text; destructuring, defaults or rest would be
  // rejected outright, and the rejection happens at the first browser call.
  const source = WorkspaceProfileService.prototype.constructor.toString();
  for (const invocation of REMOTE_INVOCATIONS) {
    const pattern = new RegExp(`\\b${invocation.implementation}\\s*\\(([^)]*)\\)`);
    const match = pattern.exec(source);
    assert.ok(match !== null, `${invocation.implementation} not found in the service class`);
    const parameters = match[1].trim();
    if (parameters === '') continue;
    for (const parameter of parameters.split(',')) {
      assert.match(parameter.trim(), /^[A-Za-z_$][A-Za-z0-9_$]*$/, `${parameter} is not a plain identifier`);
    }
  }
});

test('the service parameter names match the descriptor names', () => {
  const source = WorkspaceProfileService.prototype.constructor.toString();
  for (const invocation of REMOTE_INVOCATIONS) {
    const pattern = new RegExp(`\\b${invocation.implementation}\\s*\\(([^)]*)\\)`);
    const match = pattern.exec(source);
    const actual = match[1].split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
    assert.deepEqual(
      actual,
      [...invocation.parameters.map((parameter) => parameter.name), ...(invocation.cancellable === true ? ['signal'] : [])],
      `${invocation.implementation} parameter names drifted from the descriptor`,
    );
  }
});

test('the service class extends a Typert remote, not a plain service', async () => {
  // A plain `Service` has no `typertRemote` binding, and every browser call then
  // fails with a message that reads like a client bug while the Host is healthy.
  const source = await readFile(new URL('../src/service.js', import.meta.url), 'utf8');
  assert.ok(source.includes("from '@deepseek-ai/dsh-typert-protocol'"));
  assert.ok(/class WorkspaceProfileService extends TypertRemoteService/.test(source));
});

test('every operation is copied onto the instance rather than inherited', () => {
  // Cordis does not bind `this` when it dispatches a service, so a prototype
  // method that reached for instance state would lose it.
  const source = WorkspaceProfileService.prototype.constructor.toString();
  assert.ok(source.includes('Object.assign(this, operations)'));
});
