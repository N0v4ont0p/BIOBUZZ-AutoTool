export function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(4));
}
