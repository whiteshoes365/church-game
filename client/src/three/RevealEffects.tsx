import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { unitBoxGeometry } from './shared';

// 정답 공개 때의 작은 이펙트: 맞힌 친구 주위에는 반짝이(별 조각), 틀린 친구 옆에는
// 땀방울 하나. 전부 인스턴스 메시 하나(조명 없는 기본 재질, 그림자 없음)로 그린다.
// 인원이 많으면 한 사람당 조각 수를 줄여 전체 개수를 묶어 둔다.
export const EFFECT_SECONDS = 2.6; // 반응을 보여 주는 시간 (캐릭터 동작과 같다)
const MAX_SPARKS = 90; // 반짝이 전체 상한
const SPARKS_PER_PLAYER = { min: 3, max: 8 };
const MAX_DROPS = 30; // 땀방울 전체 상한
const BURST_S = 1.3; // 한 번 터지는 길이 (두 번 터진다)
const GRAVITY = 7;

const SPARK_COLORS = ['#ffe066', '#fff6c2', '#ffffff', '#ffc94d', '#ff9ecb'];
const DROP_COLOR = '#7fc8ff';

export interface EffectTarget {
  id: string;
  x: number;
  z: number;
  correct: boolean;
}

/** 한 사람당 반짝이 수: 인원이 늘면 줄어든다 (전체는 MAX_SPARKS 를 넘지 않는다). */
export function sparksPerPlayer(correctCount: number): number {
  if (correctCount <= 0) return 0;
  const fair = Math.floor(MAX_SPARKS / correctCount);
  return Math.max(Math.min(SPARKS_PER_PLAYER.max, fair), Math.min(SPARKS_PER_PLAYER.min, fair));
}

interface Bit {
  kind: 'spark' | 'drop';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  delay: number;
  size: number;
  spin: number;
  color: string;
}

function buildBits(targets: EffectTarget[], headY: number): Bit[] {
  const bits: Bit[] = [];
  const winners = targets.filter((t) => t.correct);
  const losers = targets.filter((t) => !t.correct).slice(0, MAX_DROPS);
  const per = sparksPerPlayer(winners.length);
  winners.forEach((t, wi) => {
    if (bits.length + per > MAX_SPARKS) return;
    for (let i = 0; i < per; i++) {
      // 좌우로 넓게, 앞뒤로는 조금만 (이름표·점수 표시가 있는 머리 위로는 높이 올라가지 않는다)
      const side = i % 2 === 0 ? 1 : -1;
      const speed = 1.1 + Math.random() * 1.3;
      bits.push({
        kind: 'spark',
        x: t.x + side * 0.25,
        y: headY * (0.75 + Math.random() * 0.2),
        z: t.z + 0.2,
        vx: side * speed,
        vy: 2 + Math.random() * 1.4,
        vz: (Math.random() - 0.5) * 1.2,
        delay: Math.random() * 0.3,
        size: 0.2 + Math.random() * 0.12,
        spin: (Math.random() - 0.5) * 10,
        color: SPARK_COLORS[(wi + i) % SPARK_COLORS.length],
      });
    }
  });
  losers.forEach((t) => {
    bits.push({
      kind: 'drop',
      x: t.x + 0.62,
      y: headY * 1.02,
      z: t.z + 0.25,
      vx: 0,
      vy: -0.7,
      vz: 0,
      delay: 0.25 + Math.random() * 0.3,
      size: 0.13,
      spin: 0,
      color: DROP_COLOR,
    });
  });
  return bits;
}

/** targets 는 공개 순간의 자리. 공개가 끝나면(부모가 떼어 내면) 사라진다. */
export function RevealEffects({ targets, headY }: { targets: EffectTarget[]; headY: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  // 공개가 시작된 순간의 자리로 한 번만 만든다 (공개 중에는 아무도 움직이지 않는다).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bits = useMemo(() => buildBits(targets, headY), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const elapsed = useRef(0);
  const done = useRef(false);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const color = new THREE.Color();
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    bits.forEach((b, i) => {
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.set(b.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [bits, dummy]);

  useEffect(() => () => material.dispose(), [material]);

  useFrame((_, delta) => {
    const mesh = ref.current;
    if (!mesh || done.current) return;
    elapsed.current += delta;
    const now = elapsed.current;
    if (now > EFFECT_SECONDS + 0.4) {
      done.current = true;
      mesh.visible = false; // 끝난 뒤에는 더 계산하지 않는다
      return;
    }
    bits.forEach((b, i) => {
      const local = now - b.delay;
      const burst = Math.floor(local / BURST_S);
      const t = local - burst * BURST_S;
      const life = b.kind === 'spark' ? 1.05 : 1.0;
      if (local < 0 || burst > 1 || t > life) {
        dummy.scale.setScalar(0);
      } else if (b.kind === 'spark') {
        const p = t / life;
        dummy.position.set(b.x + b.vx * t, b.y + b.vy * t - 0.5 * GRAVITY * t * t, b.z + b.vz * t);
        dummy.rotation.set(0, 0, Math.PI / 4 + b.spin * t);
        const s = b.size * Math.sin(Math.PI * Math.min(1, p * 1.15)) * (0.75 + 0.25 * Math.sin(t * 30 + i));
        dummy.scale.set(s, s, s * 0.3);
      } else {
        const p = t / life;
        dummy.position.set(b.x, b.y + b.vy * t, b.z);
        dummy.rotation.set(0, 0, 0);
        const s = b.size * (p < 0.15 ? p / 0.15 : 1 - Math.max(0, p - 0.7) / 0.3);
        dummy.scale.set(s * 0.8, s * 1.4, s * 0.8);
      }
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (bits.length === 0) return null;
  return <instancedMesh ref={ref} args={[unitBoxGeometry, material, bits.length]} frustumCulled={false} />;
}
