import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Clouds } from './Clouds';
import { VoxelCharacter } from './VoxelCharacter';
import { getMaterial, unitBoxGeometry } from './shared';

// 게임 종료 결과 무대: 팀(또는 등수)마다 블록 단상을 쌓고, 이긴 쪽은 높은
// 단상 위에서 폴짝폴짝 뛰어요. 하늘에서는 색종이 블록이 떨어져요.
export interface ResultColumn {
  id: string;
  color: string;
  height: number; // 단상 높이(블록 수)
  winner: boolean;
  members: { id: string; nickname: string; avatar: string }[];
}

const MAX_COLS = 4;
const SPACING = 1.25;
const CONFETTI_COLORS = ['#e2483d', '#3182f6', '#45b35c', '#f5b400', '#ec5fa3', '#9b59b6', '#ffffff'];

function columnFootprint(count: number) {
  const cols = Math.max(2, Math.min(MAX_COLS, count));
  const rows = Math.max(1, Math.ceil(count / MAX_COLS));
  return { cols, rows, width: cols * SPACING + 0.4, depth: rows * SPACING + 0.4 };
}

function Podium({ column, x }: { column: ResultColumn; x: number }) {
  const { cols, width, depth } = columnFootprint(column.members.length);
  const mat = useMemo(() => getMaterial(column.color, 0.7), [column.color]);
  const trimMat = useMemo(() => getMaterial('#1c2330'), []);
  const goldMat = useMemo(() => getMaterial('#f5c518', 0.35), []);
  const h = column.height;
  return (
    <group position={[x, 0, 0]}>
      {Array.from({ length: h }, (_, i) => (
        <mesh key={i} geometry={unitBoxGeometry} material={mat} scale={[width - i * 0.12, 0.96, depth - i * 0.12]} position={[0, i + 0.5, 0]} castShadow receiveShadow />
      ))}
      <mesh geometry={unitBoxGeometry} material={trimMat} scale={[width + 0.2, 0.12, depth + 0.2]} position={[0, 0.06, 0]} />
      {column.winner && (
        // 이긴 팀 단상 앞면의 황금 별 블록(직접 그린 십자 모양)
        <group position={[0, h - 0.5, depth / 2 + 0.06]}>
          <mesh geometry={unitBoxGeometry} material={goldMat} scale={[0.9, 0.3, 0.1]} />
          <mesh geometry={unitBoxGeometry} material={goldMat} scale={[0.3, 0.9, 0.1]} />
        </group>
      )}
      {column.members.map((m, i) => {
        const row = Math.floor(i / MAX_COLS);
        const inRow = Math.min(cols, column.members.length - row * MAX_COLS);
        const col = i % MAX_COLS;
        const px = (col - (inRow - 1) / 2) * SPACING;
        const rows = Math.ceil(column.members.length / MAX_COLS);
        const pz = (row - (rows - 1) / 2) * SPACING;
        return (
          <group key={m.id} position={[px, h, pz]}>
            <VoxelCharacter avatarId={m.avatar} nickname={m.nickname} target={[0, 0, 0]} reveal={column.winner ? 'correct' : 'idle'} scale={1.25} facing={0} />
          </group>
        );
      })}
    </group>
  );
}

function Confetti({ count = 160 }: { count?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 }), []);
  const bits = useMemo(
    () =>
      Array.from({ length: count }, () => ({
        x: (Math.random() - 0.5) * 24,
        z: (Math.random() - 0.5) * 10 - 1,
        y: Math.random() * 14,
        speed: 1.2 + Math.random() * 2.2,
        spin: 1 + Math.random() * 4,
        phase: Math.random() * Math.PI * 2,
        size: 0.12 + Math.random() * 0.16,
      })),
    [count],
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const color = new THREE.Color();
    bits.forEach((_, i) => mesh.setColorAt(i, color.set(CONFETTI_COLORS[i % CONFETTI_COLORS.length])));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [bits]);

  useFrame((state, delta) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = state.clock.elapsedTime;
    bits.forEach((b, i) => {
      b.y -= b.speed * delta;
      if (b.y < -0.2) b.y = 13 + Math.random() * 2;
      dummy.position.set(b.x + Math.sin(t * 1.3 + b.phase) * 0.5, b.y, b.z);
      dummy.rotation.set(t * b.spin, t * b.spin * 0.7 + b.phase, 0);
      dummy.scale.set(b.size, b.size * 0.35, b.size);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[unitBoxGeometry, material, count]} frustumCulled={false} />;
}

function Ground() {
  const a = useMemo(() => getMaterial('#5fb14a', 0.95), []);
  const b = useMemo(() => getMaterial('#6fc957', 0.95), []);
  const tiles = [];
  for (let x = -14; x <= 14; x += 2) {
    for (let z = -8; z <= 6; z += 2) {
      tiles.push(
        <mesh key={`${x}:${z}`} geometry={unitBoxGeometry} material={(x + z) % 4 === 0 ? a : b} scale={[2, 0.4, 2]} position={[x, -0.2, z]} receiveShadow />,
      );
    }
  }
  return <>{tiles}</>;
}

function Rig({ span, top }: { span: number; top: number }) {
  const { camera, size } = useThree();
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const persp = camera as THREE.PerspectiveCamera;
    // 무대 전체(가로 span, 높이 top)가 화면에 들어오도록 거리를 잡는다.
    const vFov = (persp.fov * Math.PI) / 180;
    const aspect = size.width / Math.max(1, size.height);
    const distW = (span / 2 + 1.5) / (Math.tan(vFov / 2) * aspect);
    const distH = (top / 2 + 2.2) / Math.tan(vFov / 2);
    const dist = Math.max(9, distW, distH);
    camera.position.set(Math.sin(t * 0.25) * 1.2, top / 2 + 2.6, dist);
    camera.lookAt(0, top / 2 + 0.6, 0);
  });
  return null;
}

export default function ResultCanvas3D({ columns }: { columns: ResultColumn[] }) {
  const widths = columns.map((c) => columnFootprint(c.members.length).width);
  const gap = 1.4;
  const span = widths.reduce((s, w) => s + w, 0) + gap * Math.max(0, columns.length - 1);
  let cursor = -span / 2;
  const xs = widths.map((w) => {
    const x = cursor + w / 2;
    cursor += w + gap;
    return x;
  });
  const top = Math.max(1, ...columns.map((c) => c.height)) + 2.4;

  return (
    <Canvas shadows dpr={[1, 1.75]} camera={{ position: [0, 6, 14], fov: 42, near: 0.1, far: 80 }}>
      <color attach="background" args={['#bfe3f0']} />
      <fog attach="fog" args={['#bfe3f0', 26, 48]} />
      <Suspense fallback={null}>
        <Rig span={span} top={top} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[6, 12, 8]} intensity={1.1} castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} shadow-camera-left={-14} shadow-camera-right={14} shadow-camera-top={14} shadow-camera-bottom={-14} />
        <Ground />
        <Clouds />
        {columns.map((c, i) => (
          <Podium key={c.id} column={c} x={xs[i]} />
        ))}
        <Confetti />
      </Suspense>
    </Canvas>
  );
}
