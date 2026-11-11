import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { decodeAvatar, SKIN_TONES, BODY_COLORS, type HatType } from '../avatars';
import { coneGeometry, getMaterial, sphereGeometry, unitBoxGeometry } from './shared';
import type { Cosmetics, MoveState } from '../protocol';
import { OutfitOverlay, outfitMaterials, ShopExtra, ShopHat, SHOP_HAT_IDS } from './Cosmetics3D';

const HAT_TYPES: HatType[] = ['none', 'cap', 'crown', 'helmet', 'flower', 'visor'];
const PANTS_COLOR = '#2f3b52';
const SHOE_COLOR = '#1c2330';

const LEG_TOP = 0.5;
const BODY_H = 0.6;
const BODY_Y = LEG_TOP + BODY_H / 2;
const SHOULDER_Y = LEG_TOP + BODY_H - 0.08;
const HEAD_Y = SHOULDER_Y + 0.42;

export const NAME_TAG_DISTANCE_FACTOR = 11;

/** 이름표가 뜨는 높이 (캐릭터 기준 단위, scale 을 곱하기 전). 상점 모자를 쓰면 조금 더 높다. */
export function nameTagHeight(hasShopHat: boolean, labelLift = 0): number {
  return HEAD_Y + (hasShopHat ? 0.85 : 0.6) + labelLift;
}

export type RevealState = 'idle' | 'correct' | 'wrong';

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
}

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
}: Props) {
  const { skin, body, hat } = decodeAvatar(avatarId);
  const skinColor = SKIN_TONES[skin];
  const bodyColor = BODY_COLORS[body];
  const hatType = HAT_TYPES[hat] ?? 'none';

  const outerRef = useRef<THREE.Group>(null);
  const bobRef = useRef<THREE.Group>(null);
  const leftArmRef = useRef<THREE.Group>(null);
  const rightArmRef = useRef<THREE.Group>(null);
  const leftLegRef = useRef<THREE.Group>(null);
  const rightLegRef = useRef<THREE.Group>(null);

  const targetVec = useRef(new THREE.Vector3(...target));
  const fallT = useRef(0);
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
    fallT.current = 0;
  }, [reveal]);

  const skinMat = useMemo(() => getMaterial(skinColor), [skinColor]);
  const baseBodyMat = useMemo(() => getMaterial(bodyColor), [bodyColor]);
  const outfit = useMemo(() => outfitMaterials(cosmetics?.outfit), [cosmetics?.outfit]);
  const bodyMat = outfit?.body ?? baseBodyMat;
  const armMat = outfit?.arm ?? baseBodyMat;
  const shopHat = cosmetics?.hat && SHOP_HAT_IDS.includes(cosmetics.hat) ? cosmetics.hat : null;
  const pantsMat = useMemo(() => getMaterial(PANTS_COLOR), []);
  const shoeMat = useMemo(() => getMaterial(SHOE_COLOR), []);

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
    if (dist > 0.001) {
      outer.position.lerp(targetVec.current, Math.min(1, delta * 3));
      if (horizontalMoving) {
        const dx = targetVec.current.x - outer.position.x;
        const dz = targetVec.current.z - outer.position.z;
        if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
          outer.rotation.y = THREE.MathUtils.lerp(outer.rotation.y, Math.atan2(dx, dz), delta * 6);
        }
      }
    } else if (typeof facing === 'number') {
      // Idle: face the camera, as requested.
      outer.rotation.y = THREE.MathUtils.lerp(outer.rotation.y, facing, delta * 6);
    }

    // Pose/limb animation driven by the server's authoritative move state
    // when available (walk/run/crawl/jump/idle); falls back to a simple
    // distance heuristic for contexts with no live server state (avatar
    // preview builder).
    const activeState: MoveState = moveState ?? (horizontalMoving ? 'walk' : 'idle');
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
        lean = 0.22;
        break;
      case 'crawl':
        swingSpeed = 5;
        swingAmp = 0.3;
        hopAmp = 0.03;
        crouch = 0.32;
        lean = 0.5;
        break;
      default:
        break;
    }

    if (tuck) {
      if (leftArmRef.current) leftArmRef.current.rotation.x = -0.5;
      if (rightArmRef.current) rightArmRef.current.rotation.x = -0.5;
      if (leftLegRef.current) leftLegRef.current.rotation.x = -0.7;
      if (rightLegRef.current) rightLegRef.current.rotation.x = -0.7;
    } else {
      const swing = Math.sin(t * swingSpeed) * swingAmp;
      if (leftArmRef.current) leftArmRef.current.rotation.x = swing;
      if (rightArmRef.current) rightArmRef.current.rotation.x = -swing;
      if (leftLegRef.current) leftLegRef.current.rotation.x = -swing;
      if (rightLegRef.current) rightLegRef.current.rotation.x = swing;
    }

    const hop = tuck ? 0 : Math.abs(Math.sin(t * swingSpeed)) * hopAmp;
    bob.position.y = hop - crouch;
    outer.rotation.x = THREE.MathUtils.lerp(outer.rotation.x, lean, delta * 5);

    if (spin) outer.rotation.y += delta * 0.9;

    if (reveal === 'wrong') {
      fallT.current = Math.min(1, fallT.current + delta * 0.9);
      outer.rotation.z = THREE.MathUtils.lerp(outer.rotation.z, Math.PI / 2.2, delta * 4);
      outer.position.y = THREE.MathUtils.lerp(outer.position.y, -0.55, delta * 4);
    } else if (reveal === 'correct') {
      outer.rotation.z = THREE.MathUtils.lerp(outer.rotation.z, 0, delta * 6);
      outer.position.y = Math.max(0, Math.abs(Math.sin(t * 7)) * 0.4);
    } else {
      outer.rotation.z = THREE.MathUtils.lerp(outer.rotation.z, 0, delta * 6);
    }
  });

  return (
    <group ref={outerRef} scale={scale}>
      <group ref={bobRef}>
        <mesh geometry={unitBoxGeometry} material={skinMat} scale={0.5} position={[0, HEAD_Y, 0]} castShadow />
        {shopHat ? <ShopHat id={shopHat} headTop={HEAD_Y + 0.25} /> : <Hat type={hatType} />}
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

        {showLabel && nickname && (
          <Html position={[0, nameTagHeight(!!shopHat, labelLift), 0]} center distanceFactor={NAME_TAG_DISTANCE_FACTOR} occlude={false}>
            <div className={`voxel-name-tag ${labelSmall ? 'small' : ''}`}>{nickname}</div>
          </Html>
        )}
      </group>
    </group>
  );
}
