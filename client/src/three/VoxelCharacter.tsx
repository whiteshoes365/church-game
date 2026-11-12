import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { decodeAvatar, SKIN_TONES, BODY_COLORS, type HatType } from '../avatars';
import { coneGeometry, getMaterial, sphereGeometry, unitBoxGeometry } from './shared';
import type { Cosmetics, Gait, MoveState } from '../protocol';
import { OutfitOverlay, outfitMaterials, ShopExtra, ShopHat, SHOP_HAT_IDS } from './Cosmetics3D';

const HAT_TYPES: HatType[] = ['none', 'cap', 'crown', 'helmet', 'flower', 'visor'];
const PANTS_COLOR = '#2f3b52';
const SHOE_COLOR = '#1c2330';

const LEG_TOP = 0.5;
const BODY_H = 0.6;
const BODY_Y = LEG_TOP + BODY_H / 2;
const SHOULDER_Y = LEG_TOP + BODY_H - 0.08;
const HEAD_Y = SHOULDER_Y + 0.42;
const NECK_Y = HEAD_Y - 0.25; // 고개를 숙일 때의 회전축 (머리 아랫면)
const FACE_Z = 0.25 + 0.011; // 머리 앞면 바로 앞

/** 정답 공개 반응(환호·주눅)을 크게 보여 주는 시간. 그 뒤에는 표정만 남기고 차분히 선다. */
export const REACTION_SECONDS = 2.6;
const CHEER_JUMP = 0.3; // 환호 점프 높이 (머리 위 점수 표시에 닿지 않게 낮게)

export const NAME_TAG_DISTANCE_FACTOR = 11;

/** 이름표가 뜨는 높이 (캐릭터 기준 단위, scale 을 곱하기 전). 상점 모자를 쓰면 조금 더 높다. */
export function nameTagHeight(hasShopHat: boolean, labelLift = 0): number {
  return HEAD_Y + (hasShopHat ? 0.85 : 0.6) + labelLift;
}

export type RevealState = 'idle' | 'correct' | 'wrong';
export type Expression = 'neutral' | 'happy' | 'sad';

/** 가장 가까운 쪽으로 도는 각도 보간 (한 바퀴 넘게 빙 돌지 않는다). */
function lerpAngle(from: number, to: number, k: number): number {
  const diff = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + diff * Math.min(1, k);
}

// 블록 얼굴: 머리 앞면에 붙인 얇은 네모들 (눈·입·볼). 표정은 기본·웃음·실망 세 가지.
function Face({ expression }: { expression: Expression }) {
  const dark = useMemo(() => getMaterial('#1c2330'), []);
  const white = useMemo(() => getMaterial('#ffffff'), []);
  const mouth = useMemo(() => getMaterial('#7a2430'), []);
  const tongue = useMemo(() => getMaterial('#ff8fa3'), []);
  const blush = useMemo(() => getMaterial('#ff9aa8'), []);
  const tear = useMemo(() => getMaterial('#7fc8ff'), []);
  const T = 0.02;
  return (
    <group position={[0, HEAD_Y, FACE_Z]}>
      {expression === 'neutral' && (
        <>
          {[-0.11, 0.11].map((x) => (
            <group key={x} position={[x, 0.05, 0]}>
              <mesh geometry={unitBoxGeometry} material={dark} scale={[0.075, 0.095, T]} />
              <mesh geometry={unitBoxGeometry} material={white} scale={[0.028, 0.028, T]} position={[0.018, 0.026, 0.004]} />
            </group>
          ))}
          <mesh geometry={unitBoxGeometry} material={dark} scale={[0.12, 0.034, T]} position={[0, -0.1, 0]} />
        </>
      )}
      {expression === 'happy' && (
        <>
          {/* 웃어서 가늘어진 눈 (^ ^) */}
          {[-0.11, 0.11].map((x) => (
            <group key={x} position={[x, 0.06, 0]}>
              <mesh geometry={unitBoxGeometry} material={dark} scale={[0.05, 0.034, T]} position={[0, 0.02, 0]} />
              <mesh geometry={unitBoxGeometry} material={dark} scale={[0.034, 0.034, T]} position={[-0.04, -0.008, 0]} />
              <mesh geometry={unitBoxGeometry} material={dark} scale={[0.034, 0.034, T]} position={[0.04, -0.008, 0]} />
            </group>
          ))}
          {/* 활짝 벌린 입 + 혀 */}
          <mesh geometry={unitBoxGeometry} material={mouth} scale={[0.2, 0.05, T]} position={[0, -0.075, 0]} />
          <mesh geometry={unitBoxGeometry} material={mouth} scale={[0.14, 0.05, T]} position={[0, -0.12, 0]} />
          <mesh geometry={unitBoxGeometry} material={tongue} scale={[0.08, 0.03, T]} position={[0, -0.128, 0.004]} />
          {[-0.18, 0.18].map((x) => (
            <mesh key={x} geometry={unitBoxGeometry} material={blush} scale={[0.07, 0.04, T]} position={[x, -0.035, 0]} />
          ))}
        </>
      )}
      {expression === 'sad' && (
        <>
          {[-0.11, 0.11].map((x) => (
            <group key={x} position={[x, 0.03, 0]}>
              <mesh geometry={unitBoxGeometry} material={dark} scale={[0.07, 0.075, T]} />
              {/* 안쪽이 올라간 눈썹 */}
              <mesh geometry={unitBoxGeometry} material={dark} scale={[0.1, 0.028, T]} position={[0, 0.085, 0]} rotation={[0, 0, x < 0 ? 0.42 : -0.42]} />
            </group>
          ))}
          {/* 아래로 처진 입 */}
          <mesh geometry={unitBoxGeometry} material={dark} scale={[0.1, 0.034, T]} position={[0, -0.1, 0]} />
          <mesh geometry={unitBoxGeometry} material={dark} scale={[0.034, 0.04, T]} position={[-0.062, -0.128, 0]} />
          <mesh geometry={unitBoxGeometry} material={dark} scale={[0.034, 0.04, T]} position={[0.062, -0.128, 0]} />
          <mesh geometry={unitBoxGeometry} material={tear} scale={[0.036, 0.06, T]} position={[0.15, -0.035, 0]} />
        </>
      )}
    </group>
  );
}

function Hat({ type }: { type: HatType }) {
  const brimMat = useMemo(() => getMaterial('#d64545'), []);
  const crownMat = useMemo(() => getMaterial('#f5c518', 0.4), []);
  const helmetMat = useMemo(() => getMaterial('#9aa5b1', 0.3), []);
  const visorMat = useMemo(() => getMaterial('#111827'), []);
  const petalMat = useMemo(() => getMaterial('#ec5fa3'), []);
  const centerMat = useMemo(() => getMaterial('#f5b400'), []);

  switch (type) {
    case 'cap':
      return (
        <group position={[0, HEAD_Y + 0.3, 0]}>
          <mesh geometry={unitBoxGeometry} material={brimMat} scale={[0.56, 0.18, 0.56]} />
          <mesh geometry={unitBoxGeometry} material={brimMat} scale={[0.2, 0.1, 0.3]} position={[0, -0.02, 0.35]} />
        </group>
      );
    case 'crown':
      return (
        <group position={[0, HEAD_Y + 0.34, 0]}>
          {[-0.15, 0, 0.15].map((x) => (
            <mesh key={x} geometry={coneGeometry} material={crownMat} scale={[0.14, 0.26, 0.14]} position={[x, 0.1, 0]} />
          ))}
        </group>
      );
    case 'helmet':
      return (
        <group position={[0, HEAD_Y + 0.28, 0]}>
          <mesh geometry={sphereGeometry} material={helmetMat} scale={[0.6, 0.5, 0.6]} />
          <mesh geometry={unitBoxGeometry} material={visorMat} scale={[0.5, 0.1, 0.1]} position={[0, -0.12, 0.28]} />
        </group>
      );
    case 'flower':
      return (
        <group position={[0, HEAD_Y + 0.3, 0]}>
          {[-0.18, 0, 0.18].map((x) => (
            <mesh key={x} geometry={sphereGeometry} material={petalMat} scale={0.18} position={[x, x === 0 ? 0.05 : 0, 0.05]} />
          ))}
          <mesh geometry={sphereGeometry} material={centerMat} scale={0.14} position={[0, 0.02, 0.12]} />
        </group>
      );
    case 'visor':
      return (
        <group position={[0, HEAD_Y + 0.26, 0]}>
          <mesh geometry={unitBoxGeometry} material={brimMat} scale={[0.56, 0.12, 0.56]} position={[0, 0.08, 0]} />
          <mesh geometry={unitBoxGeometry} material={visorMat} scale={[0.5, 0.12, 0.1]} position={[0, -0.04, 0.3]} />
        </group>
      );
    default:
      return null;
  }
}

interface Props {
  avatarId: string;
  nickname?: string;
  target: [number, number, number];
  reveal?: RevealState;
  scale?: number;
  showLabel?: boolean;
  spin?: boolean;
  facing?: number;
  moveState?: MoveState;
  cosmetics?: Cosmetics; // 상점에서 사서 착용한 아이템
  labelSmall?: boolean; // 결과 무대처럼 여럿이 붙어 설 때 작은 이름표
  labelLift?: number; // 이웃 이름표와 겹치지 않게 위로 올리는 높이
  gait?: Gait; // 뛰기·기어가기를 켠 동안 이름표 위에 표시
  celebrate?: boolean; // 시상대처럼 반응 동작(환호)을 시간 제한 없이 계속할 때
}

const GAIT_LABELS: Record<Gait, string> = { run: '뛰기!', crawl: '기어가기' };

export function VoxelCharacter({
  avatarId,
  nickname,
  target,
  reveal = 'idle',
  scale = 1,
  showLabel = true,
  spin = false,
  facing,
  moveState,
  cosmetics,
  labelSmall = false,
  labelLift = 0,
  gait,
  celebrate = false,
}: Props) {
  const { skin, body, hat } = decodeAvatar(avatarId);
  const skinColor = SKIN_TONES[skin];
  const bodyColor = BODY_COLORS[body];
  const hatType = HAT_TYPES[hat] ?? 'none';

  const outerRef = useRef<THREE.Group>(null);
  const bobRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const leftArmRef = useRef<THREE.Group>(null);
  const rightArmRef = useRef<THREE.Group>(null);
  const leftLegRef = useRef<THREE.Group>(null);
  const rightLegRef = useRef<THREE.Group>(null);

  const targetVec = useRef(new THREE.Vector3(...target));
  const reactT = useRef(0); // 지금 반응(reveal)이 시작된 뒤 흐른 시간
  const settleT = useRef(1); // 반응이 끝나고 기본 자세로 돌아온 뒤 흐른 시간
  const seed = useRef(Math.random() * Math.PI * 2);
  const mounted = useRef(false);

  useEffect(() => {
    targetVec.current.set(target[0], target[1], target[2]);
  }, [target[0], target[1], target[2]]);

  useEffect(() => {
    if (!mounted.current && outerRef.current) {
      outerRef.current.position.set(target[0], target[1], target[2]);
      mounted.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    reactT.current = 0;
    settleT.current = 0;
  }, [reveal]);

  const skinMat = useMemo(() => getMaterial(skinColor), [skinColor]);
  const baseBodyMat = useMemo(() => getMaterial(bodyColor), [bodyColor]);
  const outfit = useMemo(() => outfitMaterials(cosmetics?.outfit), [cosmetics?.outfit]);
  const bodyMat = outfit?.body ?? baseBodyMat;
  const armMat = outfit?.arm ?? baseBodyMat;
  const shopHat = cosmetics?.hat && SHOP_HAT_IDS.includes(cosmetics.hat) ? cosmetics.hat : null;
  const pantsMat = useMemo(() => getMaterial(PANTS_COLOR), []);
  const shoeMat = useMemo(() => getMaterial(SHOE_COLOR), []);
  // 표정: 맞히면 웃음, 틀리면 실망, 평소(다음 문제가 시작되면)에는 기본
  const expression: Expression = reveal === 'correct' ? 'happy' : reveal === 'wrong' ? 'sad' : 'neutral';

  useFrame((state, delta) => {
    const outer = outerRef.current;
    const bob = bobRef.current;
    if (!outer || !bob) return;

    // Position (including server-driven jump height in target.y) is always
    // smoothly interpolated toward the latest target, regardless of pose.
    const dist = outer.position.distanceTo(targetVec.current);
    const dx0 = targetVec.current.x - outer.position.x;
    const dz0 = targetVec.current.z - outer.position.z;
    const horizontalMoving = Math.hypot(dx0, dz0) > 0.03 && reveal === 'idle';
    if (dist > 0.001) outer.position.lerp(targetVec.current, Math.min(1, delta * 3));

    // 바라보는 방향: 걷는 동안에는 가는 쪽, 멈추면(또는 정답 공개 중이면) 카메라 쪽(facing).
    // 서버가 아직 걷는 중이라고 알려 주는 짧은 틈에는 돌지 않고 그대로 둔다.
    if (!spin) {
      if (horizontalMoving) {
        outer.rotation.y = lerpAngle(outer.rotation.y, Math.atan2(dx0, dz0), delta * 8);
      } else if (typeof facing === 'number' && (reveal !== 'idle' || !moveState || moveState === 'idle')) {
        outer.rotation.y = lerpAngle(outer.rotation.y, facing, delta * 7);
      }
    }

    // Pose/limb animation driven by the server's authoritative move state
    // when available (walk/run/crawl/jump/idle); falls back to a simple
    // distance heuristic for contexts with no live server state (avatar
    // preview builder).
    const activeState: MoveState = reveal !== 'idle' ? 'idle' : (moveState ?? (horizontalMoving ? 'walk' : 'idle'));
    const t = state.clock.elapsedTime + seed.current;

    let swingSpeed = 1.6;
    let swingAmp = 0.05;
    let hopAmp = 0.035;
    let crouch = 0;
    let lean = 0;
    const tuck = activeState === 'jump';

    switch (activeState) {
      case 'walk':
        swingSpeed = 10;
        swingAmp = 0.6;
        hopAmp = 0.14;
        break;
      case 'run':
        swingSpeed = 15;
        swingAmp = 0.9;
        hopAmp = 0.22;
        lean = 0.3;
        break;
      case 'crawl':
        swingSpeed = 5;
        swingAmp = 0.45;
        hopAmp = 0.03;
        crouch = 0.3;
        lean = 1.15; // 거의 엎드린 자세
        break;
      default:
        break;
    }

    // ---- 목표 자세 ----
    const swing = Math.sin(t * swingSpeed) * swingAmp;
    let armLX = tuck ? -0.5 : swing;
    let armRX = tuck ? -0.5 : -swing;
    let armSpread = 0; // 팔을 옆으로 벌리는 정도 (+ = 바깥쪽)
    let shoulderDrop = 0;
    let legLX = tuck ? -0.7 : -swing;
    let legRX = tuck ? -0.7 : swing;
    let headX = 0; // + = 고개 숙임
    let headY = 0; // 좌우로 젓기
    let bobY = (tuck ? 0 : Math.abs(Math.sin(t * swingSpeed)) * hopAmp) - crouch;
    let jump = 0;

    if (reveal !== 'idle') {
      reactT.current += delta;
      const big = celebrate || reactT.current < REACTION_SECONDS; // 큰 동작을 보여 주는 동안
      // 다 같이 한 박자로 뛰지 않게 조금씩 엇갈린다
      const rt = celebrate ? t : Math.max(0, reactT.current - (seed.current / (Math.PI * 2)) * 0.25);
      legLX = 0;
      legRX = 0;
      if (reveal === 'correct') {
        if (big) {
          // 환호: 폴짝폴짝 뛰며 두 팔을 번쩍 들고 흔든다
          const wave = Math.sin(rt * 13) * 0.22;
          armLX = Math.PI + wave;
          armRX = Math.PI - wave;
          armSpread = 0.38;
          headX = -0.16;
          jump = Math.abs(Math.sin(rt * 7)) * CHEER_JUMP;
          bobY = 0;
        } else {
          armLX = 0;
          armRX = 0;
          bobY = Math.abs(Math.sin(t * 3)) * 0.03;
        }
      } else {
        // 주눅: 고개를 떨구고 어깨가 처진다. 큰 동작이 끝나도 조금 풀이 죽은 채로 선다.
        // (카메라가 위에서 내려다보므로 얼굴이 가려지지 않을 만큼만 숙인다)
        const k = big ? 1 : 0.6;
        headX = 0.3 * k;
        headY = big && reactT.current < 1.5 ? Math.sin(rt * 5) * 0.22 : 0; // 처음에 고개를 절레절레
        armLX = 0.14 * k;
        armRX = 0.14 * k;
        armSpread = -0.1 * k;
        shoulderDrop = 0.07 * k;
        lean = 0.1 * k;
        bobY = -0.05 * k + Math.sin(t * 1.6) * 0.008;
      }
    } else {
      settleT.current += delta;
    }

    // 반응 중이거나 막 끝난 직후에는 부드럽게, 평소 걷기에서는 바로 적용한다.
    const k = reveal !== 'idle' || settleT.current < 0.35 ? Math.min(1, delta * 10) : 1;
    const la = leftArmRef.current;
    const ra = rightArmRef.current;
    if (la) {
      la.rotation.x = THREE.MathUtils.lerp(la.rotation.x, armLX, k);
      la.rotation.z = THREE.MathUtils.lerp(la.rotation.z, -armSpread, k);
      la.position.y = THREE.MathUtils.lerp(la.position.y, SHOULDER_Y - shoulderDrop, k);
    }
    if (ra) {
      ra.rotation.x = THREE.MathUtils.lerp(ra.rotation.x, armRX, k);
      ra.rotation.z = THREE.MathUtils.lerp(ra.rotation.z, armSpread, k);
      ra.position.y = THREE.MathUtils.lerp(ra.position.y, SHOULDER_Y - shoulderDrop, k);
    }
    if (leftLegRef.current) leftLegRef.current.rotation.x = THREE.MathUtils.lerp(leftLegRef.current.rotation.x, legLX, k);
    if (rightLegRef.current) rightLegRef.current.rotation.x = THREE.MathUtils.lerp(rightLegRef.current.rotation.x, legRX, k);
    const head = headRef.current;
    if (head) {
      head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, headX, Math.min(1, delta * 8));
      head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, headY, Math.min(1, delta * 10));
    }

    bob.position.y = THREE.MathUtils.lerp(bob.position.y, bobY, k);
    // 몸 기울이기는 캐릭터가 바라보는 방향 기준(앞으로 숙임)이어야 하므로 안쪽 그룹을 돌린다.
    bob.rotation.x = THREE.MathUtils.lerp(bob.rotation.x, lean, Math.min(1, delta * 6));

    if (spin) outer.rotation.y += delta * 0.9;

    // 환호 점프는 서 있는 자리(target.y) 위에서 뛴다.
    if (jump > 0) outer.position.y = targetVec.current.y + jump;
  });

  return (
    <group ref={outerRef} scale={scale}>
      <group ref={bobRef}>
        {/* 머리·얼굴·모자는 목을 축으로 함께 끄덕인다 */}
        <group ref={headRef} position={[0, NECK_Y, 0]}>
          <group position={[0, -NECK_Y, 0]}>
            <mesh geometry={unitBoxGeometry} material={skinMat} scale={0.5} position={[0, HEAD_Y, 0]} castShadow />
            <Face expression={expression} />
            {shopHat ? <ShopHat id={shopHat} headTop={HEAD_Y + 0.25} /> : <Hat type={hatType} />}
          </group>
        </group>
        <mesh geometry={unitBoxGeometry} material={bodyMat} scale={[0.5, BODY_H, 0.3]} position={[0, BODY_Y, 0]} castShadow />
        {cosmetics?.outfit && <OutfitOverlay id={cosmetics.outfit} bodyY={BODY_Y} bodyH={BODY_H} shoulderY={SHOULDER_Y} />}
        {cosmetics?.extra && <ShopExtra id={cosmetics.extra} bodyY={BODY_Y} headY={HEAD_Y} shoulderY={SHOULDER_Y} />}

        <group ref={leftArmRef} position={[-0.33, SHOULDER_Y, 0]}>
          <mesh geometry={unitBoxGeometry} material={armMat} scale={[0.16, 0.5, 0.16]} position={[0, -0.25, 0]} castShadow />
        </group>
        <group ref={rightArmRef} position={[0.33, SHOULDER_Y, 0]}>
          <mesh geometry={unitBoxGeometry} material={armMat} scale={[0.16, 0.5, 0.16]} position={[0, -0.25, 0]} castShadow />
        </group>

        <group ref={leftLegRef} position={[-0.13, LEG_TOP, 0]}>
          <mesh geometry={unitBoxGeometry} material={pantsMat} scale={[0.18, 0.4, 0.18]} position={[0, -0.2, 0]} castShadow />
          <mesh geometry={unitBoxGeometry} material={shoeMat} scale={[0.19, 0.1, 0.22]} position={[0, -0.42, 0.02]} castShadow />
        </group>
        <group ref={rightLegRef} position={[0.13, LEG_TOP, 0]}>
          <mesh geometry={unitBoxGeometry} material={pantsMat} scale={[0.18, 0.4, 0.18]} position={[0, -0.2, 0]} castShadow />
          <mesh geometry={unitBoxGeometry} material={shoeMat} scale={[0.19, 0.1, 0.22]} position={[0, -0.42, 0.02]} castShadow />
        </group>

      </group>

      {/* 이름표는 몸이 숙여져도(뛰기·기어가기) 같이 눕지 않게 바깥 그룹에 둔다 */}
      {showLabel && nickname && (
        <Html position={[0, nameTagHeight(!!shopHat, labelLift), 0]} center distanceFactor={NAME_TAG_DISTANCE_FACTOR} occlude={false}>
          <div className="voxel-name-wrap">
            {gait && <div className={`gait-chip ${gait} ${labelSmall ? 'small' : ''}`}>{GAIT_LABELS[gait]}</div>}
            <div className={`voxel-name-tag ${labelSmall ? 'small' : ''}`}>{nickname}</div>
          </div>
        </Html>
      )}
    </group>
  );
}
