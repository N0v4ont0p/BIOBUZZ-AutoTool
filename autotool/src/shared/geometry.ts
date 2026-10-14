// Path geometry, matching Pedro Pathing 3.0.1 (com.pedropathing core-3.0.1, read with javap):
// - Paths.line / Paths.curve are Bezier curves over the given points (start, controls..., end).
// - Linear heading: start + Angle.error(start, end) * pathCompletion, i.e. the SHORTEST signed turn,
//   spread over the arc-length fraction (Curve.pathCompletion = length so far / total length).
// - tangent() = direction of the curve's tangent; reverseTangent() = that + 180 deg.
// Field frame: inches, x right (toward blue wall), y up (toward the far wall), heading 0 = +x, CCW +.

export interface Vec {
  x: number;
  y: number;
}

export const DEG = Math.PI / 180;

export function wrapDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// Pedro's Angle.error: shortest signed difference end - start, in (-180, 180].
export function angleErrorDeg(startDeg: number, endDeg: number): number {
  return wrapDeg(endDeg - startDeg);
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

// Point on a Bezier curve of any degree (de Casteljau would also do; Bernstein form is exact here).
export function bezierPoint(pts: Vec[], t: number): Vec {
  const n = pts.length - 1;
  let x = 0;
  let y = 0;
  for (let i = 0; i <= n; i++) {
    const b = binom(n, i) * Math.pow(t, i) * Math.pow(1 - t, n - i);
    x += b * pts[i].x;
    y += b * pts[i].y;
  }
  return { x, y };
}

// First derivative of a Bezier curve.
export function bezierDeriv(pts: Vec[], t: number): Vec {
  const n = pts.length - 1;
  if (n < 1) return { x: 0, y: 0 };
  const d: Vec[] = [];
  for (let i = 0; i < n; i++) d.push({ x: n * (pts[i + 1].x - pts[i].x), y: n * (pts[i + 1].y - pts[i].y) });
  return n === 1 ? d[0] : bezierPoint(d, t);
}

export function bezierDeriv2(pts: Vec[], t: number): Vec {
  const n = pts.length - 1;
  if (n < 2) return { x: 0, y: 0 };
  const d: Vec[] = [];
  for (let i = 0; i < n; i++) d.push({ x: n * (pts[i + 1].x - pts[i].x), y: n * (pts[i + 1].y - pts[i].y) });
  return bezierDeriv(d, t);
}

// Signed curvature (1/in), CCW positive.
export function bezierCurvature(pts: Vec[], t: number): number {
  const d1 = bezierDeriv(pts, t);
  const d2 = bezierDeriv2(pts, t);
  const s = Math.hypot(d1.x, d1.y);
  if (s < 1e-9) return 0;
  return (d1.x * d2.y - d1.y * d2.x) / (s * s * s);
}

// Catmull-Rom through the given points, as the visualizer draws Paths.through (src/utils/math.ts
// curveThroughPoints). Pedro's BezierCurve.through fits one curve; this is a display approximation.
export function throughToBeziers(points: Vec[]): Vec[][] {
  if (points.length < 3) return [points];
  const out: Vec[][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    out.push([
      p1,
      { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      p2,
    ]);
  }
  return out;
}

export interface Sample {
  s: number; // arc length from the leg start, in
  t: number; // parameter of the piece the sample is on
  x: number;
  y: number;
  tangentDeg: number; // direction of travel
  curvature: number; // 1/in, signed
}

export interface SampledCurve {
  samples: Sample[];
  length: number;
}

// Samples a chain of Bezier pieces by arc length. `perPiece` raw steps, then resampled evenly.
export function sampleBeziers(pieces: Vec[][], step = 1.0, perPiece = 200): SampledCurve {
  const raw: Sample[] = [];
  let s = 0;
  let prev: Vec | null = null;
  let lastTangent = 0;
  for (const pts of pieces) {
    for (let i = 0; i <= perPiece; i++) {
      if (prev && i === 0) continue;
      const t = i / perPiece;
      const p = bezierPoint(pts, t);
      const d = bezierDeriv(pts, t);
      if (prev) s += dist(prev, p);
      const tan = Math.hypot(d.x, d.y) > 1e-9 ? Math.atan2(d.y, d.x) / DEG : lastTangent;
      lastTangent = tan;
      raw.push({ s, t, x: p.x, y: p.y, tangentDeg: tan, curvature: bezierCurvature(pts, t) });
      prev = p;
    }
  }
  const length = s;
  if (raw.length === 0) return { samples: [], length: 0 };
  // even resample so features and the time model see uniform steps
  const n = Math.max(2, Math.ceil(length / step) + 1);
  const samples: Sample[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (length * k) / (n - 1);
    while (j < raw.length - 2 && raw[j + 1].s < target) j++;
    const a = raw[j];
    const b = raw[Math.min(j + 1, raw.length - 1)];
    const f = b.s > a.s ? (target - a.s) / (b.s - a.s) : 0;
    samples.push({
      s: target,
      t: a.t + (b.t - a.t) * f,
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      tangentDeg: a.tangentDeg + angleErrorDeg(a.tangentDeg, b.tangentDeg) * f,
      curvature: a.curvature + (b.curvature - a.curvature) * f,
    });
  }
  return { samples, length };
}

// Heading along a leg, as Pedro computes it. `completion` = arc length fraction 0..1.
export type HeadingRule =
  | { mode: "linear"; startDeg: number; endDeg: number }
  | { mode: "constant"; deg: number }
  | { mode: "tangent" }
  | { mode: "reverseTangent" }
  | { mode: "facingPoint"; point: Vec };

export function headingAt(rule: HeadingRule, completion: number, sample: { x: number; y: number; tangentDeg: number }): number {
  switch (rule.mode) {
    case "linear":
      return wrapDeg(rule.startDeg + angleErrorDeg(rule.startDeg, rule.endDeg) * completion);
    case "constant":
      return wrapDeg(rule.deg);
    case "tangent":
      return wrapDeg(sample.tangentDeg);
    case "reverseTangent":
      return wrapDeg(sample.tangentDeg + 180);
    case "facingPoint":
      return wrapDeg(Math.atan2(rule.point.y - sample.y, rule.point.x - sample.x) / DEG);
  }
}

// --- rectangles and robot footprint ---

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Corners of the robot footprint (robot_body: +x forward, +y left) at a field pose.
export function footprint(pose: { x: number; y: number; headingDeg: number }, body: { front: number; back: number; left: number; right: number }): Vec[] {
  const c = Math.cos(pose.headingDeg * DEG);
  const s = Math.sin(pose.headingDeg * DEG);
  const local: Vec[] = [
    { x: body.front, y: body.left },
    { x: -body.back, y: body.left },
    { x: -body.back, y: -body.right },
    { x: body.front, y: -body.right },
  ];
  return local.map((p) => ({ x: pose.x + c * p.x - s * p.y, y: pose.y + s * p.x + c * p.y }));
}

export function toField(pose: { x: number; y: number; headingDeg: number }, bodyX: number, bodyY: number): Vec {
  const c = Math.cos(pose.headingDeg * DEG);
  const s = Math.sin(pose.headingDeg * DEG);
  return { x: pose.x + c * bodyX - s * bodyY, y: pose.y + s * bodyX + c * bodyY };
}

function cross(o: Vec, a: Vec, b: Vec): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function segmentsIntersect(p1: Vec, p2: Vec, q1: Vec, q2: Vec): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function rectPolygon(r: Rect): Vec[] {
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
}

// Convex polygons overlap (touching counts as no overlap).
export function polygonsOverlap(a: Vec[], b: Vec[]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

// Signed distance from a point to a rectangle (negative inside).
export function rectDistance(p: Vec, r: Rect): number {
  const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1);
  const dy = Math.max(r.y0 - p.y, 0, p.y - r.y1);
  if (dx === 0 && dy === 0) return -Math.min(p.x - r.x0, r.x1 - p.x, p.y - r.y0, r.y1 - p.y);
  return Math.hypot(dx, dy);
}

export function polygonBounds(poly: Vec[]): Rect {
  return {
    x0: Math.min(...poly.map((p) => p.x)),
    y0: Math.min(...poly.map((p) => p.y)),
    x1: Math.max(...poly.map((p) => p.x)),
    y1: Math.max(...poly.map((p) => p.y)),
  };
}

// Distance from point p to segment ab.
export function pointSegmentDistance(p: Vec, a: Vec, b: Vec): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const L2 = vx * vx + vy * vy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2)) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

// Distance from point p to a convex polygon's boundary, 0 if inside.
export function pointPolygonDistance(p: Vec, poly: Vec[]): number {
  if (pointInPolygon(p, poly)) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, pointSegmentDistance(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

export function round(v: number, places = 1): number {
  const f = Math.pow(10, places);
  return Math.round(v * f) / f;
}
