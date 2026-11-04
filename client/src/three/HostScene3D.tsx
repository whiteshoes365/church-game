import { useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Terrain } from './Terrain';
import { LetterStructure, type RevealState } from './LetterStructure';
import { Clouds } from './Clouds';
import { VoxelCharacter } from './VoxelCharacter';
import type { PlayerSnapshot, RoomStatus } from '../protocol';

interface Box {
  xmin: number;
  xmax: number;
  zmin: number;
  zmax: number;
}

const O_BOX: Box = { xmin: -7, xmax: -1.5, zmin: 1, zmax: 6.5 };
const X_BOX: Box = { xmin: 1.5, xmax: 7, zmin: 1, zmax: 6.5 };
const NEUTRAL_BOX: Box = { xmin: -6, xmax: 6, zmin: 7.5, zmax: 9 };

function layoutPositions(count: number, box: Box): [number, number][] {
  if (count === 0) return [];
  const width = box.xmax - box.xmin;
  const depth = box.zmax - box.zmin;
  const cols = Math.max(1, Math.round(Math.sqrt((count * width) / depth)));
  const rows = Math.ceil(count / cols);
  const spacingX = width / cols;
  const spacingZ = depth / rows;
  const positions: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.push([box.xmin + spacingX * (col + 0.5), box.zmin + spacingZ * (row + 0.5)]);
  }
  return positions;
}

function CameraRig() {
  const { camera } = useThree();
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    camera.position.x = Math.sin(t * 0.15) * 0.6;
    camera.position.y = 10.5 + Math.sin(t * 0.1) * 0.3;
    camera.lookAt(0, 1.8, 1);
  });
  return null;
}

interface Props {
  players: PlayerSnapshot[];
  status: RoomStatus;
  correctAnswer: 'O' | 'X' | null;
}

export function HostScene3D({ players, status, correctAnswer }: Props) {
  const oPlayers = useMemo(
    () => players.filter((p) => p.side === 'O').sort((a, b) => a.id.localeCompare(b.id)),
    [players],
  );
  const xPlayers = useMemo(
    () => players.filter((p) => p.side === 'X').sort((a, b) => a.id.localeCompare(b.id)),
    [players],
  );
  const neutralPlayers = useMemo(
    () => players.filter((p) => !p.side).sort((a, b) => a.id.localeCompare(b.id)),
    [players],
  );

  const oPositions = useMemo(() => layoutPositions(oPlayers.length, O_BOX), [oPlayers.length]);
  const xPositions = useMemo(() => layoutPositions(xPlayers.length, X_BOX), [xPlayers.length]);
  const neutralPositions = useMemo(() => layoutPositions(neutralPlayers.length, NEUTRAL_BOX), [neutralPlayers.length]);

  const revealing = status === 'reveal' && correctAnswer != null;
  const oReveal: RevealState = revealing ? (correctAnswer === 'O' ? 'correct' : 'wrong') : 'idle';
  const xReveal: RevealState = revealing ? (correctAnswer === 'X' ? 'correct' : 'wrong') : 'idle';

  return (
    <>
      <CameraRig />
      <ambientLight intensity={0.55} />
      <directionalLight
        position={[6, 10, 6]}
        intensity={1.15}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={1}
        shadow-camera-far={30}
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
      />

      <Terrain />
      <Clouds />

      <LetterStructure shape="O" origin={[-6, 0, -1.2]} reveal={oReveal} />
      <LetterStructure shape="X" origin={[6, 0, -1.2]} reveal={xReveal} />

      {oPlayers.map((p, i) => (
        <VoxelCharacter
          key={p.id}
          avatarId={p.avatar}
          nickname={p.nickname}
          target={[oPositions[i][0], 0, oPositions[i][1]]}
          reveal={oReveal}
          scale={1.5}
          facing={Math.PI}
        />
      ))}
      {xPlayers.map((p, i) => (
        <VoxelCharacter
          key={p.id}
          avatarId={p.avatar}
          nickname={p.nickname}
          target={[xPositions[i][0], 0, xPositions[i][1]]}
          reveal={xReveal}
          scale={1.5}
          facing={Math.PI}
        />
      ))}
      {neutralPlayers.map((p, i) => (
        <VoxelCharacter
          key={p.id}
          avatarId={p.avatar}
          nickname={p.nickname}
          target={[neutralPositions[i][0], 0, neutralPositions[i][1]]}
          reveal="idle"
          scale={1.5}
        />
      ))}
    </>
  );
}
