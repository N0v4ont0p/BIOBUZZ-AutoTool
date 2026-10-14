import { domToBlob } from "modern-screenshot";

export interface ExportImageOptions {
  /**
   * Multiplier applied to the element's rendered size.
   * `2` produces a double resolution (Retina friendly) image.
   */
  scale?: number;
  /**
   * Color painted behind the element. `null` (default) keeps the PNG
   * transparent so only what the element itself paints is exported.
   */
  backgroundColor?: string | null;
  /** How long to wait for images and fonts to be embedded, in milliseconds. */
  timeout?: number;
  /** Report embedding progress while assets are downloaded. */
  onProgress?: (current: number, total: number) => void;
}

/**
 * Rasterize a live DOM element into a PNG blob.
 *
 * Nested SVGs (the Two.js scene), `<canvas>` layers, images and text are all
 * captured, and every CSS color the browser understands is supported:
 * the element is serialized into an SVG `<foreignObject>` and rendered by the
 * browser itself.
 *
 * This is why `html2canvas` is no longer used here: it re-implements CSS in
 * JavaScript, so it throws
 * `Attempting to parse an unsupported color function "oklch"` as soon as it
 * meets the modern color functions (`oklch()`, `oklab()`, `lab()`, `lch()`,
 * `color-mix()`, ...) that Tailwind v4 emits and that Chrome reports from
 * `getComputedStyle`.
 */
export async function exportElementAsPng(
  element: HTMLElement,
  {
    scale = 2,
    backgroundColor = null,
    timeout = 30_000,
    onProgress,
  }: ExportImageOptions = {},
): Promise<Blob> {
  const blob = await domToBlob(element, {
    type: "image/png",
    scale,
    backgroundColor,
    timeout,
    ...(onProgress ? { progress: onProgress } : {}),
  });

  if (!blob || blob.size === 0) {
    throw new Error("The browser did not return any image data.");
  }

  return blob;
}
