/**
 * InterruptionModule
 * 
 * Manages how the room handles interruptions (buffering, ads) from individual peers.
 * Implements a flexible policy design using the Strategy Pattern.
 */

const TAG = '[InterruptionModule]';

// ── Strategy Base ───────────────────────────────────────────
class InterruptionPolicy {
  handleStart(module, userId, videoId, videoTime) {
    throw new Error('Not implemented');
  }
  
  handleEnd(module, userId, videoId, videoTime) {
    throw new Error('Not implemented');
  }
}

// ── Concrete Strategies ──────────────────────────────────────

/**
 * TimeBoxedPausePolicy (Default)
 * Pauses the room for buffering, but if a user is stuck for > 10s, 
 * auto-resumes the room and flags the user as 'ignored' until they catch up.
 */
class TimeBoxedPausePolicy extends InterruptionPolicy {
  handleStart(module, userId, videoId, videoTime) {
    module.syncEngine.handlePause(userId, videoTime);

    // Clear existing timer if any to prevent race conditions
    if (module.timers.has(userId)) {
      clearTimeout(module.timers.get(userId));
    }

    // Start 10s TimeBox
    const timer = setTimeout(() => {
      console.log(`${TAG} User ${userId} timeout (10s) reached. Auto-resuming room and ignoring user.`);
      module.timers.delete(userId);
      module.interruptedUsers.delete(userId);
      module.ignoredUsers.add(userId);

      // If no one else is strictly holding up the room, resume
      if (module.interruptedUsers.size === 0) {
        // Use 'system' or the current host as the sender for the auto-resume
        module.syncEngine.handlePlay(module.syncEngine.peerId || 'system', videoTime);
      }
    }, 10000);

    module.timers.set(userId, timer);
  }

  handleEnd(module, userId, videoId, videoTime) {
    // Clear timer if the interruption ended before the 10s limit
    if (module.timers.has(userId)) {
      clearTimeout(module.timers.get(userId));
      module.timers.delete(userId);
    }

    // If the user was already ignored, they just caught up. Clean up their state.
    if (module.ignoredUsers.has(userId)) {
      console.log(`${TAG} Ignored user ${userId} has caught up.`);
      module.ignoredUsers.delete(userId);
      return; 
    }

    // If they finished buffering within the 10s window, check if others are still buffering
    if (module.interruptedUsers.size === 0) {
      console.log(`${TAG} All interruptions cleared, resuming room.`);
      module.syncEngine.handlePlay(userId, videoTime);
    }
  }
}

/**
 * PauseAllPolicy
 * Strict sync. Pauses room for everyone. Resumes room if no users are still interrupted.
 */
class PauseAllPolicy extends InterruptionPolicy {
  handleStart(module, userId, videoId, videoTime) {
    module.syncEngine.handlePause(userId, videoTime);
  }

  handleEnd(module, userId, videoId, videoTime) {
    if (module.interruptedUsers.size === 0) {
      console.log(`${TAG} All interruptions cleared, resuming room.`);
      module.syncEngine.handlePlay(userId, videoTime);
    }
  }
}

/**
 * IgnorePolicy
 * Interrupted users catch up normally on their own. No room-wide sync pauses.
 */
class IgnorePolicy extends InterruptionPolicy {
  handleStart(module, userId, videoId, videoTime) {
    // No-op
  }

  handleEnd(module, userId, videoId, videoTime) {
    // No-op
  }
}

export const Policies = {
  TIME_BOXED_PAUSE: new TimeBoxedPausePolicy(),
  PAUSE_ALL: new PauseAllPolicy(),
  IGNORE: new IgnorePolicy()
};

// ── Context (Interruption Module) ────────────────────────────
export class InterruptionModule {
  constructor(syncEngine, connectionManager) {
    this.syncEngine = syncEngine;
    this.connectionManager = connectionManager;
    
    this.interruptedUsers = new Map(); // Users currently actively buffering/in ad
    this.ignoredUsers = new Set();     // Users who timed out under TimeBoxed policy
    this.timers = new Map();           // Stores active timeouts for TimeBoxed policy
    
    // Blueprint dictates TimeBoxedPausePolicy as the default
    this.policy = Policies.TIME_BOXED_PAUSE;
  }

  setPolicy(policyName) {
    if (Policies[policyName]) {
      this.policy = Policies[policyName];
      console.log(`${TAG} Policy set to ${policyName}`);
    } else {
      console.warn(`${TAG} Unknown policy ${policyName}`);
    }
  }

  handleInterruptionStart(userId, videoId, videoTime) {
    console.log(`${TAG} User ${userId} interruption started at ${videoTime}`);
    this.interruptedUsers.set(userId, true);
    this.policy.handleStart(this, userId, videoId, videoTime);
  }

  handleInterruptionEnd(userId, videoId, videoTime) {
    console.log(`${TAG} User ${userId} interruption ended at ${videoTime}`);
    this.interruptedUsers.delete(userId);
    this.policy.handleEnd(this, userId, videoId, videoTime);
  }
  
  clearUser(userId) {
    if (this.timers.has(userId)) {
      clearTimeout(this.timers.get(userId));
      this.timers.delete(userId);
    }
    this.interruptedUsers.delete(userId);
    this.ignoredUsers.delete(userId);
  }
  
  clearAll() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.interruptedUsers.clear();
    this.ignoredUsers.clear();
  }
}