/**
 * Server endpoint configuration.
 *
 * The single place the backend location is defined. Both the WebSocket
 * transport and the ICE-server fetch read from here, so switching between a
 * local server and the deployed one is a one-line change that cannot leave the
 * two disagreeing.
 *
 * To develop against a local server, set USE_LOCAL_SERVER to true and run:
 *
 *     cd server && PYTHONPATH=. uvicorn main:app --reload
 *
 * Set it back to false before loading the extension for a demo — a build
 * pointing at localhost fails silently for everyone but you.
 */

/** @type {boolean} Flip to true to talk to a server on this machine. */
const USE_LOCAL_SERVER = false;

/** Host and port of the deployed server. */
const REMOTE_HOST = 'sync-l5pk.onrender.com';

/** Host and port of a local development server. */
const LOCAL_HOST = 'localhost:8000';

const host = USE_LOCAL_SERVER ? LOCAL_HOST : REMOTE_HOST;

// localhost is exempt from the secure-context requirement, so plain ws/http is
// fine there and avoids needing a self-signed certificate for development.
const wsScheme = USE_LOCAL_SERVER ? 'ws' : 'wss';
const httpScheme = USE_LOCAL_SERVER ? 'http' : 'https';

/** True when pointing at a local server. Used to warn on startup. */
export const IS_LOCAL_SERVER = USE_LOCAL_SERVER;

/** Base URL for HTTP endpoints, no trailing slash. */
export const HTTP_BASE = `${httpScheme}://${host}`;

/** Where short-lived TURN credentials come from. */
export const ICE_ENDPOINT = `${HTTP_BASE}/turn-credentials`;

/**
 * Build the room WebSocket URL for a peer.
 * @param {string} roomId
 * @param {string} peerId
 * @returns {string}
 */
export function buildSocketUrl(roomId, peerId) {
  return `${wsScheme}://${host}/ws/${roomId}/${peerId}`;
}
