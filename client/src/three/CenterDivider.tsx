import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { unitBoxGeometry } from './shared';

// O 구역(왼쪽, 초록)과 X 구역(오른쪽, 빨강) 사이, 지도 한가운데(x = 0)를 가르는 낮은 블록 담.
// - 가운데: 흰색/남색이 번갈아 놓인 블록 담 (발목 높이라 캐릭터를 가리지 않는다)
// - 왼쪽 옆: 초록 띠(O 쪽), 오른쪽 옆: 빨강 띠(X 쪽)
// - 맨 뒤(글자 블록 사이): 높은 줄무늬 기둥 + O/X 색 깃발 블록
const Z_START = -1.5;
const Z_END = 9.5;
const WALL_W = 0.5;
const WALL_H = 0.3;
const STRIPE_W = 0.3;
const STRIPE_H = 0.1;
const POST_BLOCKS = 6;

const WHITE = new THREE.Color('#ffffff');
const NAVY = new THREE.Color('#1c2330');
const YELLOW = new THREE.Color('#f5c518');
const O_GREEN = new THREE.Color('#45b35c');
const X_RED = new THREE.Color('#e2483d');

interface Block {
  pos: [number, number, number];
  scale: [number, number, number];
  color: THREE.Color;
}

function buildBlocks(): Block[] {
  const blocks: Block[] = [];
  const count = Math.round((Z_END - Z_START) / 0.5);
  for (let i = 0; i < count; i++) {
    const z = Z_START + 0.25 + i * 0.5;
    // 가운데 담: 블록 하나씩 흰색/남색, 두 칸마다 조금 높은 노란 블록으로 "블록 담" 느낌을 낸다.
    const tall = i % 4 === 0;
    blocks.push({
      pos: [0, (tall ? WALL_H + 0.12 : WALL_H) / 2, z],
      scale: [WALL_W, tall ? WALL_H + 0.12 : WALL_H, 0.48],
      color: tall ? YELLOW : i % 2 === 0 ? WHITE : NAVY,
    });
    blocks.push({ pos: [-(WALL_W + STRIPE_W) / 2, STRIPE_H / 2, z], scale: [STRIPE_W, STRIPE_H, 0.5], color: O_GREEN });
    blocks.push({ pos: [(WALL_W + STRIPE_W) / 2, STRIPE_H / 2, z], scale: [STRIPE_W, STRIPE_H, 0.5], color: X_RED });
  }
  // 뒤쪽 기둥 (글자 O 와 X 사이, 놀이 구역 밖)
  for (let i = 0; i < POST_BLOCKS; i++) {
    blocks.push({ pos: [0, 0.3 + i * 0.6, Z_START - 0.3], scale: [0.6, 0.6, 0.6], color: i % 2 === 0 ? WHITE : NAVY });
  }
  const top = 0.3 + POST_BLOCKS * 0.6;
  blocks.push({ pos: [-0.55, top - 0.9, Z_START - 0.3], scale: [0.5, 0.6, 0.3], color: O_GREEN });
  blocks.push({ pos: [0.55, top - 0.9, Z_START - 0.3], scale: [0.5, 0.6, 0.3], color: X_RED });
  blocks.push({ pos: [0, top + 0.05, Z_START - 0.3], scale: [0.8, 0.3, 0.8], color: YELLOW });
  return blocks;
}

export function CenterDivider() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const blocks = useMemo(buildBlocks, []);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.7 }), []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    blocks.forEach((b, i) => {
      dummy.position.set(...b.pos);
      dummy.scale.set(...b.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, b.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [blocks]);

  return <instancedMesh ref={meshRef} args={[unitBoxGeometry, material, blocks.length]} castShadow receiveShadow />;
}
