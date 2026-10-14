/**
 * A unique, opaque id for a path.
 */
export function makePathId(): string {
  return `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
