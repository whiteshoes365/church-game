import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { unitBoxGeometry } from './shared';

const COLS = 17;
const ROWS = 11;
export const BLOCK_H = 0.4;

const GRASS = new THREE.Color('#5fb14a');
const GRASS_ALT = new THREE.Color('#6fc957');
const DIRT = new THREE.Color('#8b5a2b');

export function Terrain() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const count = COLS * ROWS;

  // Note: no `vertexColors: true` here — that flag also pulls in a per-vertex
  // `color` geometry attribute (USE_COLOR) which our shared BoxGeometry doesn't
  // have, zeroing the final color. Per-instance color (USE_INSTANCING_COLOR) is
  // enabled automatically once `instanceColor` exists on the mesh.
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95 }), []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    let i = 0;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const x = col - (COLS - 1) / 2;
        const z = row - 1;
        dummy.position.set(x, -BLOCK_H / 2, z);
        dummy.scale.set(1, BLOCK_H, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        const isDirt = (Math.abs(x) + Math.abs(z)) % 5 === 0;
        const color = isDirt ? DIRT : (x + z) % 2 === 0 ? GRASS : GRASS_ALT;
        mesh.setColorAt(i, color);
        i++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, []);

  return <instancedMesh ref={meshRef} args={[unitBoxGeometry, material, count]} receiveShadow />;
}
