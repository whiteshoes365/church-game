import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { unitBoxGeometry } from './shared';

// 달란트 상점 꾸미기 아이템의 3D 모양. 전부 직접 만든 블록(상자) 조합이에요.
// 좌표는 VoxelCharacter 의 몸 기준 (머리 중심 HEAD_Y, 몸통 중심 BODY_Y).

const cache = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: string, opts: { roughness?: number; metalness?: number; opacity?: number } = {}) {
  const key = `${color}|${opts.roughness ?? 0.8}|${opts.metalness ?? 0.05}|${opts.opacity ?? 1}`;
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.roughness ?? 0.8,
      metalness: opts.metalness ?? 0.05,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
    });
    cache.set(key, m);
  }
  return m;
}

type V3 = [number, number, number];
function Box({ color, size, pos, opts }: { color: string; size: V3; pos?: V3; opts?: Parameters<typeof mat>[1] }) {
  const material = useMemo(() => mat(color, opts), [color, opts]);
  return <mesh geometry={unitBoxGeometry} material={material} scale={size} position={pos} castShadow />;
}

export const SHOP_HAT_IDS = ['hat-sprout', 'hat-melon', 'hat-propeller', 'hat-ruby'];

// headTop: 머리 윗면의 y
export function ShopHat({ id, headTop }: { id: string; headTop: number }) {
  const blade = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (blade.current) blade.current.rotation.y += delta * 9;
  });
  switch (id) {
    case 'hat-sprout':
      return (
        <group position={[0, headTop, 0]}>
          <Box color="#a9643a" size={[0.34, 0.16, 0.34]} pos={[0, 0.08, 0]} />
          <Box color="#7a4526" size={[0.4, 0.05, 0.4]} pos={[0, 0.17, 0]} />
          <Box color="#3f9b3a" size={[0.06, 0.22, 0.06]} pos={[0, 0.3, 0]} />
          <Box color="#5fc94f" size={[0.18, 0.07, 0.1]} pos={[-0.11, 0.4, 0]} />
          <Box color="#5fc94f" size={[0.18, 0.07, 0.1]} pos={[0.11, 0.44, 0]} />
        </group>
      );
    case 'hat-melon':
      return (
        <group position={[0, headTop, 0]}>
          <Box color="#e2483d" size={[0.6, 0.05, 0.6]} pos={[0, 0.0, 0]} />
          <Box color="#4fb548" size={[0.58, 0.24, 0.58]} pos={[0, 0.13, 0]} />
          {[-0.19, 0, 0.19].map((x) => (
            <Box key={x} color="#2c7a2f" size={[0.08, 0.25, 0.6]} pos={[x, 0.13, 0]} />
          ))}
        </group>
      );
    case 'hat-propeller':
      return (
        <group position={[0, headTop, 0]}>
          <Box color="#3182f6" size={[0.54, 0.14, 0.54]} pos={[0, 0.07, 0]} />
          <Box color="#e2483d" size={[0.32, 0.05, 0.2]} pos={[0, 0.03, 0.34]} />
          <Box color="#f5c518" size={[0.06, 0.16, 0.06]} pos={[0, 0.22, 0]} />
          <group ref={blade} position={[0, 0.32, 0]}>
            <Box color="#e2483d" size={[0.56, 0.04, 0.1]} />
            <Box color="#45b35c" size={[0.1, 0.04, 0.56]} />
          </group>
        </group>
      );
    case 'hat-ruby':
      return (
        <group position={[0, headTop, 0]}>
          <Box color="#f5c518" size={[0.56, 0.12, 0.56]} pos={[0, 0.06, 0]} opts={{ metalness: 0.6, roughness: 0.3 }} />
          {[
            [-0.22, -0.22],
            [0.22, -0.22],
            [-0.22, 0.22],
            [0.22, 0.22],
            [0, 0.22],
          ].map(([x, z]) => (
            <Box key={`${x}:${z}`} color="#f5c518" size={[0.12, 0.14, 0.12]} pos={[x, 0.19, z]} opts={{ metalness: 0.6, roughness: 0.3 }} />
          ))}
          <Box color="#e0245e" size={[0.16, 0.14, 0.08]} pos={[0, 0.07, 0.29]} opts={{ roughness: 0.2, metalness: 0.3 }} />
        </group>
      );
    default:
      return null;
  }
}

// 옷: 몸통/팔 재질을 바꾸고, 무늬 블록을 몸통 위에 덧댄다.
export function outfitMaterials(id: string | undefined): { body: THREE.MeshStandardMaterial; arm: THREE.MeshStandardMaterial } | null {
  switch (id) {
    case 'outfit-checker':
      return { body: mat('#f4f1e6'), arm: mat('#2b3a67') };
    case 'outfit-rainbow':
      return { body: mat('#9b59b6'), arm: mat('#9b59b6') };
    case 'outfit-ice': {
      const ice = mat('#bfefff', { roughness: 0.12, metalness: 0.25, opacity: 0.88 });
      return { body: ice, arm: ice };
    }
    case 'outfit-gold': {
      const gold = mat('#f5c518', { roughness: 0.28, metalness: 0.7 });
      return { body: gold, arm: gold };
    }
    default:
      return null;
  }
}

const RAINBOW = ['#e2483d', '#f08a24', '#f5c518', '#45b35c', '#3182f6'];

export function OutfitOverlay({ id, bodyY, bodyH, shoulderY }: { id: string; bodyY: number; bodyH: number; shoulderY: number }) {
  switch (id) {
    case 'outfit-checker': {
      const cells = [];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 2; c++) {
          if ((r + c) % 2 !== 0) continue;
          cells.push(<Box key={`${r}${c}`} color="#2b3a67" size={[0.252, bodyH / 3 + 0.002, 0.32]} pos={[(c - 0.5) * 0.25, bodyY + (1 - r) * (bodyH / 3), 0]} />);
        }
      }
      return <>{cells}</>;
    }
    case 'outfit-rainbow':
      return (
        <>
          {RAINBOW.map((color, i) => (
            <Box key={color} color={color} size={[0.52, bodyH / 5 + 0.002, 0.32]} pos={[0, bodyY + (2 - i) * (bodyH / 5), 0]} />
          ))}
        </>
      );
    case 'outfit-ice':
      return (
        <>
          <Box color="#e8fbff" size={[0.24, 0.12, 0.24]} pos={[-0.33, shoulderY + 0.02, 0]} opts={{ roughness: 0.1 }} />
          <Box color="#e8fbff" size={[0.24, 0.12, 0.24]} pos={[0.33, shoulderY + 0.02, 0]} opts={{ roughness: 0.1 }} />
          <Box color="#7fd6f5" size={[0.2, 0.2, 0.33]} pos={[0, bodyY + 0.06, 0]} opts={{ roughness: 0.1 }} />
        </>
      );
    case 'outfit-gold':
      return (
        <>
          <Box color="#d99a00" size={[0.34, 0.3, 0.34]} pos={[0, bodyY + 0.08, 0]} opts={{ metalness: 0.7, roughness: 0.3 }} />
          <Box color="#fff2a8" size={[0.12, 0.12, 0.36]} pos={[0, bodyY + 0.1, 0]} opts={{ metalness: 0.5, roughness: 0.2 }} />
          <Box color="#d99a00" size={[0.26, 0.12, 0.26]} pos={[-0.33, shoulderY + 0.03, 0]} opts={{ metalness: 0.7, roughness: 0.3 }} />
          <Box color="#d99a00" size={[0.26, 0.12, 0.26]} pos={[0.33, shoulderY + 0.03, 0]} opts={{ metalness: 0.7, roughness: 0.3 }} />
        </>
      );
    default:
      return null;
  }
}

export function ShopExtra({ id, bodyY, headY, shoulderY }: { id: string; bodyY: number; headY: number; shoulderY: number }) {
  const pet = useRef<THREE.Group>(null);
  const wingL = useRef<THREE.Group>(null);
  const wingR = useRef<THREE.Group>(null);
  const cape = useRef<THREE.Group>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (pet.current) {
      pet.current.position.y = headY + Math.sin(t * 2.4) * 0.08;
      pet.current.rotation.y = Math.sin(t * 1.2) * 0.4;
    }
    const flap = Math.sin(t * 6) * 0.35;
    if (wingL.current) wingL.current.rotation.y = -0.5 - flap;
    if (wingR.current) wingR.current.rotation.y = 0.5 + flap;
    if (cape.current) cape.current.rotation.x = 0.18 + Math.sin(t * 2) * 0.06;
  });
  switch (id) {
    case 'extra-cape':
      return (
        <>
          <Box color="#c0392b" size={[0.56, 0.08, 0.36]} pos={[0, shoulderY + 0.05, 0]} />
          <group ref={cape} position={[0, shoulderY + 0.04, -0.18]}>
            <Box color="#e2483d" size={[0.5, 0.78, 0.05]} pos={[0, -0.39, 0]} />
            <Box color="#f5c518" size={[0.5, 0.06, 0.055]} pos={[0, -0.75, 0]} />
          </group>
        </>
      );
    case 'extra-pet':
      return (
        <group ref={pet} position={[0.62, headY, 0.12]}>
          <Box color="#18a999" size={[0.26, 0.26, 0.26]} />
          <Box color="#ffffff" size={[0.07, 0.08, 0.02]} pos={[-0.06, 0.03, 0.135]} />
          <Box color="#ffffff" size={[0.07, 0.08, 0.02]} pos={[0.06, 0.03, 0.135]} />
          <Box color="#1c2330" size={[0.035, 0.04, 0.02]} pos={[-0.06, 0.02, 0.146]} />
          <Box color="#1c2330" size={[0.035, 0.04, 0.02]} pos={[0.06, 0.02, 0.146]} />
          <Box color="#f5c518" size={[0.08, 0.1, 0.08]} pos={[0, 0.18, 0]} />
        </group>
      );
    case 'extra-wings':
      return (
        <>
          <group ref={wingL} position={[-0.1, bodyY + 0.12, -0.17]}>
            <Box color="#ffffff" size={[0.42, 0.22, 0.04]} pos={[-0.22, 0.1, 0]} />
            <Box color="#dfe9f5" size={[0.3, 0.2, 0.04]} pos={[-0.17, -0.1, 0]} />
            <Box color="#c5d5ea" size={[0.16, 0.16, 0.04]} pos={[-0.1, -0.27, 0]} />
          </group>
          <group ref={wingR} position={[0.1, bodyY + 0.12, -0.17]}>
            <Box color="#ffffff" size={[0.42, 0.22, 0.04]} pos={[0.22, 0.1, 0]} />
            <Box color="#dfe9f5" size={[0.3, 0.2, 0.04]} pos={[0.17, -0.1, 0]} />
            <Box color="#c5d5ea" size={[0.16, 0.16, 0.04]} pos={[0.1, -0.27, 0]} />
          </group>
        </>
      );
    default:
      return null;
  }
}
