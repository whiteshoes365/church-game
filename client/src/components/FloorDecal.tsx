import { useMemo } from 'react';
import { FLOOR_GRID, floorTileColor, floorTiles, type FloorKey } from '../floorMarks';

/** 바닥 O/X 타일 그림 (SVG). 3D 무대의 바닥 타일과 같은 칸·같은 색이다.
 *  부모 상자를 구역 사각형에 맞추면 그 안을 꽉 채우고, 밖으로 나가지 않는다. */
export function FloorDecal({ shape }: { shape: FloorKey }) {
  const tiles = useMemo(() => floorTiles(shape, { xmin: 0, xmax: FLOOR_GRID, zmin: 0, zmax: FLOOR_GRID }), [shape]);
  return (
    <svg className="floor-decal" viewBox={`0 0 ${FLOOR_GRID} ${FLOOR_GRID}`} preserveAspectRatio="none" aria-hidden="true" shapeRendering="crispEdges">
      {tiles.map((t) => (
        // 칸 사이에 실금이 보이지 않게 아주 조금 겹친다 (넘친 부분은 SVG 가 잘라 낸다)
        <rect key={`${t.col}:${t.row}`} x={t.col} y={t.row} width={1.02} height={1.02} fill={floorTileColor(t)} />
      ))}
    </svg>
  );
}
