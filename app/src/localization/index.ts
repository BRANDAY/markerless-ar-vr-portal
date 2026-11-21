import { ManualPlacementProvider } from './ManualPlacementProvider';
import { ReactVisionVpsProvider } from './ReactVisionVpsProvider';
import { SelfHostedServerProvider } from './SelfHostedServerProvider';
import { ArCoreCloudAnchorProvider } from './stubs';
import type { LocalizationProvider, ProviderId } from './types';

export * from './types';

/** Every provider the app knows, including the one that is only a stub. */
export const PROVIDER_IDS: ProviderId[] = [
  'manual',
  'reactvision-vps',
  'arcore-cloud-anchor',
  'self-hosted',
];

/**
 * The providers the "Provider" button of the debug panel switches between, in that order.
 * `reactvision-vps` says "not set up" in a build without ReactVision keys. The stub
 * (`arcore-cloud-anchor`) is left out: choosing it only removed the door and showed
 * "not implemented".
 */
export const SELECTABLE_PROVIDER_IDS: ProviderId[] = ['manual', 'self-hosted', 'reactvision-vps'];

export function createProvider(id: ProviderId): LocalizationProvider {
  switch (id) {
    case 'manual':
      return new ManualPlacementProvider();
    case 'reactvision-vps':
      return new ReactVisionVpsProvider();
    case 'arcore-cloud-anchor':
      return new ArCoreCloudAnchorProvider();
    case 'self-hosted':
      return new SelfHostedServerProvider();
  }
}
