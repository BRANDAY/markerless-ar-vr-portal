/**
 * The camera of the running AR view, for code that is neither the scene nor a provider
 * (measuring the bridge of a room). The scene registers itself while it is mounted.
 */
import type { CameraPose } from './types';

let source: (() => CameraPose | null) | null = null;

export const arCamera = {
  /** Called by the AR scene: `null` when the view goes. */
  setSource(next: (() => CameraPose | null) | null): void {
    source = next;
  },

  /** The latest camera pose in this AR session, or null without a view or before its first pose. */
  get(): CameraPose | null {
    return source ? source() : null;
  },
};
