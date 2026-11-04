import * as THREE from 'three';

// Shared geometries/materials so every voxel block and character limb reuses
// the same GPU buffers instead of allocating per-instance.
export const unitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
export const coneGeometry = new THREE.ConeGeometry(0.5, 1, 4);
export const sphereGeometry = new THREE.SphereGeometry(0.5, 8, 6);

const materialCache = new Map<string, THREE.MeshStandardMaterial>();

export function getMaterial(color: string, roughness = 0.85): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}`;
  let mat = materialCache.get(key);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 });
    materialCache.set(key, mat);
  }
  return mat;
}
