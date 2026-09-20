/**
 * The `workspaceProfile` Typert Remote service.
 *
 * ## Why one object serves both callers
 *
 * The Gateway resolves a Remote call's receiver by `descriptor.service`, so the
 * service that owns the namespace is the same object the browser reaches. A
 * second "facade" service under the same name would collide
 * (`service "workspaceProfile" has been registered at <root>`).
 *
 * ## Two structural rules, both learned the hard way elsewhere
 *
 * **It must extend `TypertRemoteService`, not plain `Service`.** A plain service
 * has no `typertRemote` binding, and every browser call then fails with
 * `Service "workspaceProfile" has no visible typertRemote binding` — a message
 * that reads like a client bug while the Host side looks perfectly healthy.
 *
 * **The operations are copied onto the instance, not inherited.** Cordis does not
 * bind `this` when it dispatches a service, so a prototype method reaching for
 * instance state would find nothing. Copying closures makes that impossible
 * rather than merely unlikely.
 *
 * ## Why every Remote member is a `remoteX` wrapper
 *
 * The Gateway reads a Remote member's source text and rejects any parameter that
 * is not a plain identifier. `savePolicy({ workspaceId, patch })` is a
 * destructuring pattern and would be rejected outright, so each member is a thin
 * `remoteX(args, signal)` and the descriptor's `implementation` points at it.
 * The parameter COUNT must match the descriptor exactly, cancellation included.
 *
 * @module dsh-workspace-profile/service
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

import { WORKSPACE_PROFILE_NAMESPACE } from './remote/invocations.js';

/** The service the browser reads as `ctx.remote.workspaceProfile`. */
export class WorkspaceProfileService extends TypertRemoteService {
  /**
   * @param {any} ctx - the owning context.
   * @param {Record<string, Function>} operations - the business operations.
   */
  constructor(ctx, operations) {
    super(ctx, WORKSPACE_PROFILE_NAMESPACE);
    Object.assign(this, operations);
  }

  /**
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<any>} the Settings snapshot.
   */
  remoteSnapshot(signal) {
    return this.snapshot(signal);
  }

  /**
   * @param {any} args - `{ workspaceId }`.
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<any>} the Skill catalog.
   */
  remoteSkills(args, signal) {
    return this.skills(args, signal);
  }

  /**
   * @param {any} args - `{ workspaceId, profile?, perspective? }`.
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<any>} the prompt sections this Workspace contributes.
   */
  remotePreviewInjection(args, signal) {
    return this.previewInjection(args, signal);
  }

  /**
   * @param {any} args - `{ workspaceId }`.
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<any>} the Matter facts and the comparison against the policy.
   */
  remoteMatter(args, signal) {
    return this.matter(args, signal);
  }

  /**
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<any>} the model catalog.
   */
  remoteModels(signal) {
    return this.models(signal);
  }

  /**
   * @param {any} args - a route.
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<any>} the verdict.
   */
  remoteValidateRoute(args, signal) {
    return this.validateRoute(args, signal);
  }

  /**
   * @param {any} args - `{ workspaceId, expectedRevision, patch }`.
   * @returns {Promise<any>} the write outcome.
   */
  remoteSavePolicy(args) {
    return this.savePolicy(args);
  }

  /**
   * @param {any} args - `{ workspaceId, expectedRevision, subagent }`.
   * @returns {Promise<any>} the write outcome.
   */
  remotePutSubagent(args) {
    return this.putSubagent(args);
  }

  /**
   * @param {any} args - `{ workspaceId, expectedRevision, subagentId, key, name }`.
   * @returns {Promise<any>} the write outcome.
   */
  remoteDuplicateSubagent(args) {
    return this.duplicateSubagent(args);
  }

  /**
   * @param {any} args - `{ workspaceId, expectedRevision, subagentId }`.
   * @returns {Promise<any>} the write outcome.
   */
  remoteRemoveSubagent(args) {
    return this.removeSubagent(args);
  }

  /**
   * @param {any} args - `{ workspaceId, expectedRevision, skill, state }`.
   * @returns {Promise<any>} the write outcome.
   */
  remoteSetSkillState(args) {
    return this.setSkillState(args);
  }

  /**
   * @param {any} args - `{ workspaceId, expectedRevision }`.
   * @returns {Promise<any>} the write outcome.
   */
  remotePruneOrphan(args) {
    return this.pruneOrphan(args);
  }
}

export default WorkspaceProfileService;
