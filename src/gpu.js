// Renderer backend selection.
//
// The whole app runs on three's WebGPURenderer. It now DEFAULTS to the actual
// WebGPU backend (what the migration was for — far lower draw-call overhead and
// the headroom for all the dynamic objects/effects), and auto-falls back to the
// WebGL2 backend on devices without WebGPU. Force the WebGL2 fallback with
// ?webgl=1 (e.g. to A/B the two backends, or work around a flaky GPU driver).
const _params = new URLSearchParams(location.search);
export const USE_WEBGPU = !_params.has("webgl"); // default WebGPU; ?webgl=1 forces the fallback
