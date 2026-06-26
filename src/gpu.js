// WebGPU migration flag (branch: claude/webgpu-migration).
//
// The whole app now runs on three's WebGPURenderer. By default it uses the
// WebGPU renderer's WebGL2 backend (the safe baseline, works everywhere);
// add ?webgpu=1 to the URL to select the actual WebGPU backend instead. Both
// run the identical node pipeline, so it's a clean on-device A/B.
export const USE_WEBGPU = new URLSearchParams(location.search).has("webgpu");
