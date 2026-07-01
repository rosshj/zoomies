// Unit checks for the WebRTC transport's pure routing decisions (the stateful
// RTCPeerConnection mesh can only be tested live, but these guard the logic that
// decides who initiates and how the Ably state-fallback is de-duplicated).
// Run: `npm run check:net`.
import { isInitiator, acceptAblyState } from "../src/net/webrtc.js";

let failures = 0;
const check = (name, cond) => { console.log((cond ? "  ok  " : "FAIL  ") + name); if (!cond) failures++; };

// Initiator is deterministic (lower id offers) and never both sides.
check("lower id initiates", isInitiator("aaa", "bbb") === true);
check("higher id waits", isInitiator("bbb", "aaa") === false);
check("exactly one side initiates a pair", isInitiator("x", "y") !== isInitiator("y", "x"));

// Ably state-fallback dedup: accept when there's no live P2P link, drop when there is.
check("no peer yet → accept Ably state", acceptAblyState(undefined) === true);
check("peer still connecting → accept Ably state", acceptAblyState({ ready: false }) === true);
check("peer P2P-live → drop the Ably duplicate", acceptAblyState({ ready: true }) === false);

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nall net checks passed");
