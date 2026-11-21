/**
 * The photo of the view (`docs/product/ui-spec.md`, 5.9 "Shutter"): how its file is
 * named, what the AR view's screenshot call answers, and how long the preview stays. Pure.
 */

/** The preview of a photo goes away after this long. */
export const PHOTO_PREVIEW_MS = 4000;

const two = (n: number) => String(n).padStart(2, '0');

/**
 * A file name without extension (the AR view adds its own): the product's name in small
 * letters and the local time, so that photos sort by when they were taken.
 */
export function photoName(product: string, at: Date): string {
  const name = product.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'photo';
  return (
    `${name}-${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
  );
}

export type PhotoResult =
  /** `uri` can be shown by an image view. `inGallery`: the phone's gallery has it as well. */
  | { ok: true; uri: string; inGallery: boolean }
  | { ok: false; reason: string };

/**
 * What the AR view's `takeScreenshot` resolved with: `{ success, url, errorCode }`, where
 * `url` is a path on the phone. Anything else is a failure, with a reason for the log.
 */
export function readScreenshot(answer: unknown, inGallery: boolean): PhotoResult {
  const json = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : null;
  if (!json) {
    return { ok: false, reason: 'the AR view gave no answer' };
  }
  const url = typeof json.url === 'string' ? json.url : '';
  if (json.success !== true || !url) {
    const code = typeof json.errorCode === 'number' ? ` (code ${json.errorCode})` : '';
    return { ok: false, reason: `the AR view could not save the picture${code}` };
  }
  return { ok: true, uri: /^[a-z]+:\/\//i.test(url) ? url : `file://${url}`, inGallery };
}
