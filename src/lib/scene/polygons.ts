import Two from "two.js";
import type { Path as TwoPath } from "two.js/src/path";
import type { BasePoint, TimePrediction } from "../../types";
import type { SceneScales } from "./types";

export function buildClosedPolygon(
  points: BasePoint[],
  { x, y }: SceneScales,
): TwoPath {
  const vertices = [
    new Two.Anchor(
      x(points[0].x),
      y(points[0].y),
      0,
      0,
      0,
      0,
      Two.Commands.move,
    ),
  ];

  for (let i = 1; i < points.length; i++) {
    vertices.push(
      new Two.Anchor(
        x(points[i].x),
        y(points[i].y),
        0,
        0,
        0,
        0,
        Two.Commands.line,
      ),
    );
  }

  vertices.push(
    new Two.Anchor(
      x(points[0].x),
      y(points[0].y),
      0,
      0,
      0,
      0,
      Two.Commands.close,
    ),
  );

  vertices.forEach((vertex) => (vertex.relative = false));

  const polygon = new Two.Path(vertices);
  polygon.automatic = false;
  return polygon;
}

export function buildGhostPath(
  ghostPoints: BasePoint[],
  options: { id: string; color: string },
  scales: SceneScales,
): TwoPath | null {
  if (ghostPoints.length < 3) return null;

  const ghostPath = buildClosedPolygon(ghostPoints, scales);
  ghostPath.id = options.id;
  ghostPath.stroke = options.color;
  ghostPath.fill = options.color;
  ghostPath.opacity = 0.15;
  ghostPath.linewidth = scales.x(0.5);
  return ghostPath;
}

export function buildOnionLayer(
  corners: BasePoint[],
  options: { id: string; color: string },
  scales: SceneScales,
): TwoPath {
  const layer = buildClosedPolygon(corners, scales);
  layer.id = options.id;
  layer.stroke = options.color;
  layer.noFill();
  // Increase opacity so colliders are more visible
  layer.opacity = 0.9;
  layer.linewidth = scales.x(0.28);
  return layer;
}

/**
 * When "onion layers for the next point only" is enabled, narrow the layers to
 * the travel segment the playhead is currently in, or the next one upcoming.
 */
export function selectVisibleOnionLayers<T extends { lineId?: string }>(
  layers: T[],
  prediction: TimePrediction | null | undefined,
  percent: number,
  nextPointOnly: boolean | undefined,
): T[] {
  if (!nextPointOnly || !prediction || !prediction.timeline) return layers;

  const currentTime = (prediction.totalTime || 0) * (percent / 100);
  const travelEvents = (prediction.timeline || []).filter(
    (ev) => ev.type === "travel",
  );

  let selectedLineId: string | null = null;

  const currentTravel = travelEvents.find(
    (ev) => ev.startTime <= currentTime && ev.endTime >= currentTime,
  );
  if (currentTravel) {
    selectedLineId = currentTravel.lineId ?? null;
  } else {
    const nextTravel = travelEvents.find((ev) => ev.startTime > currentTime);
    if (nextTravel) selectedLineId = nextTravel.lineId ?? null;
    else if (travelEvents.length)
      selectedLineId = travelEvents[travelEvents.length - 1].lineId ?? null;
  }

  if (selectedLineId === null) return layers;
  return layers.filter((layer) => layer.lineId === selectedLineId);
}
