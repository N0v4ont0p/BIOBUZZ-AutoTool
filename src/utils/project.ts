import type { Path, SequenceItem, Settings, Shape, StartPose } from "../types";
import type { FieldPoint } from "./fieldPoints";

export const PROJECT_VERSION = "1.5.0";

/**
 * A warning when the document came from a newer build, else null. Fields added
 * after this build are dropped silently, so the file may not mean what it says.
 */
export function newerVersionWarning(version: unknown): string | null {
  if (typeof version !== "string") return null;

  const parse = (value: string) =>
    value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const stored = parse(version);
  const current = parse(PROJECT_VERSION);

  for (
    let index = 0;
    index < Math.max(stored.length, current.length);
    index++
  ) {
    const left = stored[index] ?? 0;
    const right = current[index] ?? 0;
    if (left > right) {
      return `This file was saved by a newer version of the visualizer (${version}, this build writes ${PROJECT_VERSION}). Some settings may not load correctly.`;
    }
    if (left < right) return null;
  }

  return null;
}

export interface ProjectDoc {
  startPoint: StartPose;
  lines: Path[];
  shapes: Shape[];
  sequence: SequenceItem[];
  fieldPoints?: FieldPoint[];
  settings?: Settings;
  activePaths?: string[];
}

export function buildProject(
  doc: ProjectDoc,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...doc,
    version: PROJECT_VERSION,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

export function serializeProject(
  doc: ProjectDoc,
  options: { pretty?: boolean; overrides?: Record<string, unknown> } = {},
): string {
  const { pretty = false, overrides = {} } = options;
  return JSON.stringify(
    buildProject(doc, overrides),
    null,
    pretty ? 2 : undefined,
  );
}
