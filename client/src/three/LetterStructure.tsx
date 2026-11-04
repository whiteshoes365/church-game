import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { unitBoxGeometry } from './shared';

const O_PATTERN = [
  [1, 1, 1, 1, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 1, 1, 1, 1],
];

const X_PATTERN = [
  [1, 0, 0, 0, 1],
  [0, 1, 0, 1, 0],
  [0, 0, 1, 0, 0],
  [0, 1, 0, 1, 0],
  [1, 0, 0, 0, 1],
];

interface Cell {
  x: number;
  y: number;
  z: number;
}

function buildCells(pattern: number[][]): Cell[] {
  const cells: Cell[] = [];
  pattern.forEach((rowArr, row) => {
    rowArr.forEach((filled, col) => {
      if (!filled) return;
      const x = col - 2;
      const y = 4 - row + 0.5;
      cells.push({ x, y, z: -0.5 }, { x, y, z: 0.5 });
    });
  });
  return cells;
}

const O_CELLS = buildCells(O_PATTERN);
const X_CELLS = buildCells(X_PATTERN);

export type RevealState = 'idle' | 'correct' | 'wrong';

interface Props {
  shape: 'O' | 'X';
  origin: [number, number, number];
  reveal: RevealState;
}

export function LetterStructure({ shape, origin, reveal }: Props) {
  const cells = shape === 'O' ? O_CELLS : X_CELLS;
  const baseColor = shape === 'O' ? '#45b35c' : '#e2483d';

  const meshRef = useRef<THREE.InstancedMesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const revealT = useRef(0);

  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: baseColor,
        roughness: 0.6,
        emissive: baseColor,
        emissiveIntensity: 0,
      }),
    [baseColor],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    cells.forEach((cell, i) => {
      dummy.position.set(cell.x, cell.y, cell.z);
      dummy.scale.setScalar(0.94);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [cells]);

  useEffect(() => {
    revealT.current = 0;
  }, [reveal]);

  useFrame((state, delta) => {
    const group = groupRef.current;
    if (!group) return;
    const t = state.clock.elapsedTime;
    revealT.current += delta;

    if (reveal === 'wrong') {
      const flashing = revealT.current < 0.5;
      material.emissiveIntensity = flashing ? Math.abs(Math.sin(t * 28)) * 0.9 : 0;
      const sinkPull = flashing ? 0 : delta * 1.4;
      group.position.y = THREE.MathUtils.lerp(group.position.y, -3.5, sinkPull);
      group.rotation.z = THREE.MathUtils.lerp(group.rotation.z, 0.3, delta * 1.2);
    } else if (reveal === 'correct') {
      material.emissiveIntensity = 0.5 + Math.abs(Math.sin(t * 4)) * 0.3;
      group.position.y = Math.abs(Math.sin(t * 3)) * 0.4;
      group.rotation.z = THREE.MathUtils.lerp(group.rotation.z, 0, delta * 4);
    } else {
      material.emissiveIntensity = THREE.MathUtils.lerp(material.emissiveIntensity, 0, delta * 4);
      group.position.y = THREE.MathUtils.lerp(group.position.y, 0, delta * 4);
      group.rotation.z = THREE.MathUtils.lerp(group.rotation.z, 0, delta * 4);
    }
  });

  return (
    <group ref={groupRef} position={origin}>
      <instancedMesh ref={meshRef} args={[unitBoxGeometry, material, cells.length]} castShadow receiveShadow />
    </group>
  );
}
