import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { unitBoxGeometry } from './shared';
import { floorTileColor, floorTiles, type FloorKey } from '../floorMarks';
import type { Rect } from '../protocol';
import type { RevealState } from './LetterStructure';

// 바닥에 크게 깐 O / X 타일. 서버 채점 구역(zones) 사각형을 그대로 덮으므로
// "타일 위에 서 있으면 그 답" 이다. 구역 하나가 인스턴스 메시 하나(121칸)라 가볍다.
const BASE_H = 0.03; // 구역 바닥 타일 두께 (잔디 위로 살짝)
const LETTER_H = 0.07; // 글자 타일은 조금 더 도드라지게

const DIM = new THREE.Color('#b4b9c1');
const WHITE = new THREE.Color('#ffffff');

interface Props {
  shape: FloorKey;
  box: Rect;
  reveal: RevealState;
}

export function FloorMark({ shape, box, reveal }: Props) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const tiles = useMemo(() => floorTiles(shape, box), [shape, box.xmin, box.xmax, box.zmin, box.zmax]);
  const glow = shape === 'O' ? '#45b35c' : '#e2483d';
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, emissive: glow, emissiveIntensity: 0 }),
    [glow],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    tiles.forEach((tile, i) => {
      const h = tile.letter ? LETTER_H : BASE_H;
      dummy.position.set(tile.x, h / 2, tile.z);
      dummy.scale.set(tile.w, h, tile.d);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.set(floorTileColor(tile)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [tiles]);

  useFrame((state, delta) => {
    const k = Math.min(1, delta * 5);
    if (reveal === 'correct') {
      material.emissiveIntensity = 0.28 + Math.abs(Math.sin(state.clock.elapsedTime * 4)) * 0.3;
      material.color.lerp(WHITE, k);
    } else if (reveal === 'wrong') {
      material.emissiveIntensity = THREE.MathUtils.lerp(material.emissiveIntensity, 0, k);
      material.color.lerp(DIM, k);
    } else {
      material.emissiveIntensity = THREE.MathUtils.lerp(material.emissiveIntensity, 0, k);
      material.color.lerp(WHITE, k);
    }
  });

  return <instancedMesh ref={meshRef} args={[unitBoxGeometry, material, tiles.length]} receiveShadow />;
}
