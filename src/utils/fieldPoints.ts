import type { FieldPoint } from "../types";

export type { FieldPoint } from "../types";

function toFieldPoint(value: unknown): FieldPoint | null {
  if (!value) return null;

  if (Array.isArray(value)) {
    const [x, y, color, radius, opacity] = value;
    if (typeof x !== "number" || typeof y !== "number") return null;
    const point: FieldPoint = { x, y };
    if (typeof color === "string") point.color = color;
    if (typeof radius === "number") point.radius = radius;
    if (typeof opacity === "number") point.opacity = opacity;
    return point;
  }

  if (typeof value === "object") {
    const candidate = value as Partial<FieldPoint> & {
      x?: unknown;
      y?: unknown;
      color?: unknown;
      radius?: unknown;
      opacity?: unknown;
    };

    if (typeof candidate.x !== "number" || typeof candidate.y !== "number") {
      return null;
    }

    const point: FieldPoint = { x: candidate.x, y: candidate.y };
    if (typeof candidate.color === "string") point.color = candidate.color;
    if (typeof candidate.radius === "number") point.radius = candidate.radius;
    if (typeof candidate.opacity === "number")
      point.opacity = candidate.opacity;
    return point;
  }

  return null;
}

export function normalizeFieldPoints(input: unknown): FieldPoint[] {
  const rawPoints = Array.isArray(input)
    ? input
    : input && typeof input === "object"
      ? ((input as any).fieldPoints ??
        (input as any).points ??
        (input as any).dots ??
        [])
      : [];

  if (!Array.isArray(rawPoints)) return [];
  return rawPoints
    .map(toFieldPoint)
    .filter((point): point is FieldPoint => Boolean(point));
}

export function renderFieldPoints(
  canvas: HTMLCanvasElement | null | undefined,
  points: FieldPoint[],
  xScale: (value: number) => number,
  yScale: (value: number) => number,
  width: number,
  height: number,
  defaultRadius = 2.2,
  defaultColor = "rgba(34, 197, 94, 0.9)",
): void {
  if (!canvas || width <= 0 || height <= 0) return;

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (points.length === 0) return;

  const buckets = new Map<
    string,
    { color: string; radius: number; opacity: number; points: FieldPoint[] }
  >();

  for (const point of points) {
    const color = point.color || defaultColor;
    const radius = Math.max(0.6, point.radius ?? defaultRadius);
    const opacity = Math.max(0, Math.min(1, point.opacity ?? 1));
    const key = `${color}|${radius}|${opacity}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { color, radius, opacity, points: [] };
      buckets.set(key, bucket);
    }
    bucket.points.push(point);
  }

  ctx.save();
  for (const bucket of buckets.values()) {
    ctx.fillStyle = bucket.color;
    ctx.globalAlpha = bucket.opacity;
    ctx.beginPath();
    for (const point of bucket.points) {
      const px = xScale(point.x);
      const py = yScale(point.y);
      ctx.moveTo(px + bucket.radius, py);
      ctx.arc(px, py, bucket.radius, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.restore();
}
