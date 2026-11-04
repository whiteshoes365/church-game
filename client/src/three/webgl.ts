// Cheap, synchronous WebGL support check — no three.js import needed,
// so pages can decide whether it's worth lazy-loading the 3D chunk at all.
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return !!gl;
  } catch {
    return false;
  }
}
