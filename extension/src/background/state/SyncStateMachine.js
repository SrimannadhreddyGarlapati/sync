/**
 * SyncStateMachine — State Pattern
 * 
 * Manages the lifecycle states of a sync session. Each state determines
 * what actions are valid and what UI feedback to show.
 * 
 * States:
 *   DISCONNECTED → JOINING → SYNCING → SYNCED ⇄ DRIFTING
 *                                  ↓              ↓
 *                            RECONNECTING ←───────┘
 *                                  ↓
 *                            DISCONNECTED
 * 
 * OOP Pillar: State pattern — behavior changes based on internal state
 * without conditionals scattered across the codebase.
 * 
 * OS Pillar: Mirrors process state transitions (NEW → READY → RUNNING → 
 * WAITING → TERMINATED) in an operating system scheduler.
 */

import { EventBus } from '../EventBus.js';

/** @enum {string} */
export const SyncState = Object.freeze({
  DISCONNECTED:  'DISCONNECTED',
  JOINING:       'JOINING',
  SYNCING:       'SYNCING',
  SYNCED:        'SYNCED',
  DRIFTING:      'DRIFTING',
  RECONNECTING:  'RECONNECTING',
});

/**
 * Allowed state transitions. Each key maps to the set of states
 * reachable from it. Any transition not listed here is rejected.
 */
const TRANSITIONS = Object.freeze({
  [SyncState.DISCONNECTED]:  new Set([SyncState.JOINING]),
  [SyncState.JOINING]:       new Set([SyncState.SYNCING, SyncState.DISCONNECTED]),
  [SyncState.SYNCING]:       new Set([SyncState.SYNCED, SyncState.DRIFTING, SyncState.DISCONNECTED, SyncState.RECONNECTING]),
  [SyncState.SYNCED]:        new Set([SyncState.DRIFTING, SyncState.DISCONNECTED, SyncState.RECONNECTING]),
  [SyncState.DRIFTING]:      new Set([SyncState.SYNCING, SyncState.SYNCED, SyncState.DISCONNECTED, SyncState.RECONNECTING]),
  [SyncState.RECONNECTING]:  new Set([SyncState.JOINING, SyncState.DISCONNECTED]),
});

export class SyncStateMachine {
  /**
   * @param {EventBus} eventBus - Shared event bus for state change notifications
   */
  constructor(eventBus) {
    /** @type {EventBus} */
    this._eventBus = eventBus;

    /** @type {string} */
    this._state = SyncState.DISCONNECTED;

    /** @type {string|null} Previous state for UI transition animations */
    this._previousState = null;
  }

  /**
   * Current state.
   * @returns {string}
   */
  get state() {
    return this._state;
  }

  /**
   * Previous state (useful for UI transition logic).
   * @returns {string|null}
   */
  get previousState() {
    return this._previousState;
  }

  /**
   * Attempt a state transition. Throws if the transition is not allowed.
   * @param {string} newState - Target state (must be a SyncState value)
   * @returns {boolean} true if transition succeeded, false if already in state
   * @throws {Error} if the transition is invalid
   */
  transition(newState) {
    // Idempotency: Ignore self-transitions to prevent async race condition crashes
    if (this._state === newState) {
      return false; 
    }

    // Safer enum validation using Object.hasOwn
    if (!Object.hasOwn(SyncState, newState)) {
      throw new Error(`[SyncStateMachine] Unknown state: "${newState}"`);
    }

    const allowed = TRANSITIONS[this._state];
    if (!allowed || !allowed.has(newState)) {
      throw new Error(
        `[SyncStateMachine] Invalid transition: ${this._state} → ${newState}`
      );
    }

    this._previousState = this._state;
    this._state = newState;

    console.debug(`[SyncStateMachine] ${this._previousState} → ${this._state}`);

    this._eventBus.emit('state:changed', {
      current: this._state,
      previous: this._previousState,
    });

    return true;
  }

  /**
   * Check if a transition to the given state is valid from the current state.
   * @param {string} targetState
   * @returns {boolean}
   */
  canTransition(targetState) {
    if (this._state === targetState) return true;
    const allowed = TRANSITIONS[this._state];
    return allowed ? allowed.has(targetState) : false;
  }

  /**
   * Force-reset to DISCONNECTED (e.g., on unrecoverable error).
   * Bypasses normal transition validation.
   */
  reset() {
    if (this._state === SyncState.DISCONNECTED) {
      return; // Already disconnected
    }

    this._previousState = this._state;
    this._state = SyncState.DISCONNECTED;

    console.warn(`[SyncStateMachine] Force-reset to DISCONNECTED from ${this._previousState}`);

    this._eventBus.emit('state:changed', {
      current: this._state,
      previous: this._previousState,
    });
  }
}