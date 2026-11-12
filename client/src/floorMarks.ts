// 바닥 O/X 표시의 모양과 자리 계산 (3D 무대·학생 2D 지도·2D 대체 화면이 함께 쓴다).
//
// 표시는 서버가 채점에 쓰는 구역 사각형(ZONES, server/src/state.js)을 그대로
// FLOOR_GRID × FLOOR_GRID 칸으로 나눠 깐다. 칸은 구역 사각형 밖으로 나가지 않으므로
// 표시가 보이는 범위 = 채점 범위다. (verify 가 이 파일을 직접 불러 검사한다.)
//
// 이 파일은 React·three 를 쓰지 않는 순수 계산만 담는다.

export interface FloorRect {
  xmin: number;
  xmax: number;
  zmin: number;
  zmax: number;
}

export type FloorKey = 'O' | 'X';

/** 한 구역을 나누는 칸 수 (가로·세로 같음). */
export const FLOOR_GRID = 11;

/** 글자가 차지하는 칸인지. row 0 = 뒤쪽(zmin), col 0 = 왼쪽(xmin). */
export function isLetterCell(key: FloorKey, col: number, row: number): boolean {
  const last = FLOOR_GRID - 1;
  // 글자는 가장자리 한 칸을 비운 안쪽 정사각형에 그린다.
  if (col < 1 || row < 1 || col > last - 1 || row > last - 1) return false;
  const i = row - 1;
  const j = col - 1;
  const n = last - 2; // 안쪽 정사각형의 마지막 번호
  if (key === 'O') {
    const ring = i <= 1 || j <= 1 || i >= n - 1 || j >= n - 1;
    const corner = (i === 0 || i === n) && (j === 0 || j === n); // 모서리를 깎아 둥글게
    return ring && !corner;
  }
  return Math.abs(i - j) <= 1 || Math.abs(i + j - n) <= 1;
}

export interface FloorTile {
  key: FloorKey;
  col: number;
  row: number;
  letter: boolean;
  /** 칸 중심 (무대 좌표) */
  x: number;
  z: number;
  /** 칸 크기 */
  w: number;
  d: number;
}

/** 한 구역 사각형을 빈틈없이 덮는 칸들. 모든 칸은 사각형 안에 있다. */
export function floorTiles(key: FloorKey, box: FloorRect): FloorTile[] {
  const w = (box.xmax - box.xmin) / FLOOR_GRID;
  const d = (box.zmax - box.zmin) / FLOOR_GRID;
  const tiles: FloorTile[] = [];
  for (let row = 0; row < FLOOR_GRID; row++) {
    for (let col = 0; col < FLOOR_GRID; col++) {
      tiles.push({
        key,
        col,
        row,
        letter: isLetterCell(key, col, row),
        x: box.xmin + (col + 0.5) * w,
        z: box.zmin + (row + 0.5) * d,
        w,
        d,
      });
    }
  }
  return tiles;
}

/** 바닥 색 (O = 초록, X = 빨강). base 는 구역 바닥, letter 는 글자 칸. 두 가지씩 번갈아 깔아 블록 느낌을 낸다. */
export const FLOOR_COLORS: Record<FloorKey, { base: [string, string]; letter: [string, string] }> = {
  O: { base: ['#d3f3c8', '#c3ecb6'], letter: ['#2f9e4b', '#3cb25a'] },
  X: { base: ['#fbd5cd', '#f6c4ba'], letter: ['#d63a30', '#e8503f'] },
};

export function floorTileColor(tile: FloorTile): string {
  const set = FLOOR_COLORS[tile.key][tile.letter ? 'letter' : 'base'];
  return set[(tile.col + tile.row) % 2];
}
