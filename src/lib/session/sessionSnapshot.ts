import type {
  Path,
  SequenceItem,
  Settings,
  Shape,
  StartPose,
} from "../../types";
import { DEFAULT_SETTINGS } from "../../config/defaults";
import {
  deriveSequence,
  normalizePaths,
  normalizeStartPose,
} from "../../utils/normalize";
import { normalizeLegacyFieldMap } from "../../utils/settingsPersistence";

export const SESSION_RECOVERY_KEY = "pedro_session_recovery_v1";

export interface SessionSnapshot {
  startPoint: StartPose;
  lines: Path[];
  sequence: SequenceItem[];
  shapes: Shape[];
  settings: Settings;
  currentFilePath: string | null;
  secondFilePath: string | null;
  secondStartPoint: StartPose | null;
  secondLines: Path[];
  secondSequence: SequenceItem[];
  secondShapes: Shape[];
  activePaths: string[];
  timestamp: string;
}

export function saveSessionSnapshot(snapshot: SessionSnapshot): void {
  try {
    localStorage.setItem(SESSION_RECOVERY_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.error("Session snapshot save failed:", error);
  }
}

/**
 * Read and normalize the recovery snapshot. Returns null when absent or
 * unusable, so callers can fall back to defaults.
 */
export function loadSessionSnapshot(): SessionSnapshot | null {
  try {
    const raw = localStorage.getItem(SESSION_RECOVERY_KEY);
    if (!raw) return null;

    const parsed: SessionSnapshot = JSON.parse(raw);
    if (!parsed?.startPoint || !Array.isArray(parsed?.lines)) {
      return null;
    }

    const lines = normalizePaths(parsed.lines || []);
    const secondLines = normalizePaths(parsed.secondLines || []);

    return {
      startPoint: normalizeStartPose(parsed.startPoint),
      lines,
      sequence: deriveSequence(parsed, lines),
      shapes: parsed.shapes || [],
      settings: normalizeLegacyFieldMap({
        ...DEFAULT_SETTINGS,
        ...(parsed.settings || {}),
      }),
      currentFilePath: parsed.currentFilePath || null,
      secondFilePath: parsed.secondFilePath || null,
      secondStartPoint: parsed.secondStartPoint
        ? normalizeStartPose(parsed.secondStartPoint)
        : null,
      secondLines,
      secondSequence: deriveSequence(
        { sequence: parsed.secondSequence },
        secondLines,
      ),
      secondShapes: parsed.secondShapes || [],
      activePaths: parsed.activePaths || [],
      timestamp: parsed.timestamp,
    };
  } catch (error) {
    console.error("Session restore failed:", error);
    return null;
  }
}
