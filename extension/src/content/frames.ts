/**
 * Injected into every frame, so SingleFile's frame-tree handshake has someone
 * to answer.
 *
 * The top frame's capture asks each child frame to identify itself over
 * postMessage. Without this responder present no frame replies, each one burns
 * a 5s TIMEOUT_INIT_REQUEST_MESSAGE, and the iframe serialises empty anyway —
 * five seconds per iframe-bearing page in exchange for nothing.
 *
 * Importing the module is the entire job: `content-frame-tree.js` calls `init()`
 * at module scope, which registers the `message` listener.
 *
 * This also lands in the top frame, where the capture bundle already carries its
 * own copy of the same code. That is harmless: the two bundles hold separate
 * module state, so this copy has no session registered and its message branches
 * no-op.
 */
import "single-file-core/single-file-frames.js";
