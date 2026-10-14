import type { Settings } from "../../types";

/** Keys of Settings whose value is a number (optional or not). */
export type NumericSettingKey = {
  [K in keyof Settings]-?: NonNullable<Settings[K]> extends number ? K : never;
}[keyof Settings];

/** Parse a raw input string into a clamped number, treating junk as 0. */
export function clampNumberInput(
  value: string,
  min?: number,
  max?: number,
): number {
  let num = parseFloat(value);
  if (isNaN(num)) num = 0;
  if (min !== undefined) num = Math.max(min, num);
  if (max !== undefined) num = Math.min(max, num);
  return num;
}
