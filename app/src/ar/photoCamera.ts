/**
 * The photo of the view (`docs/product/ui-spec.md`, 5.9 "Shutter"): the AR view's own
 * screenshot call, which captures the camera image with the door and the space and none
 * of the buttons drawn over it.
 *
 * NOT TRIED ON A DEVICE: that the picture really is without the interface, where the
 * engine writes it, and whether saving to the phone's gallery needs a permission the app
 * does not ask for. The gallery is tried first; if the engine refuses, the picture is
 * taken into the app's own storage, so that there is at least a preview.
 */
import { BRAND } from '../brand';
import { type PhotoResult, photoName, readScreenshot } from '../ui/core/photo';

/** The subset of ViroReact's `arSceneNavigator` object a photo needs. */
interface PhotoNavigator {
  takeScreenshot?: (fileName: string, saveToCameraRoll: boolean) => Promise<unknown>;
}

let navigator: PhotoNavigator | null = null;
let busy = false;

export const photoCamera = {
  /** Called by the AR scene with the object ViroReact injects as `arSceneNavigator`. */
  attach(value: unknown): void {
    navigator = value && typeof value === 'object' ? (value as PhotoNavigator) : null;
  },

  /** Takes one photo. Never throws; a second call while one is being taken is refused. */
  async take(log: (text: string) => void): Promise<PhotoResult> {
    const shoot = navigator?.takeScreenshot;
    if (typeof shoot !== 'function') {
      return { ok: false, reason: 'the AR view has no screenshot call' };
    }
    if (busy) {
      return { ok: false, reason: 'a photo is being taken' };
    }
    busy = true;
    try {
      const name = photoName(BRAND.name, new Date());
      let result = readScreenshot(await shoot(name, true), true);
      if (!result.ok) {
        log(`photo: not saved to the gallery (${result.reason}) - taking it into the app's storage`);
        result = readScreenshot(await shoot(name, false), false);
      }
      log(result.ok ? `photo: ${name}${result.inGallery ? ', in the gallery' : ', in the app only'}` : `photo: ${result.reason}`);
      return result;
    } catch (error) {
      return { ok: false, reason: `the screenshot call failed: ${String(error)}` };
    } finally {
      busy = false;
    }
  },
};
