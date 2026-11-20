import { ManualPlacementProvider } from './ManualPlacementProvider';
import { SelfHostedServerProvider } from './SelfHostedServerProvider';
import { ArCoreCloudAnchorProvider, ReactVisionVpsProvider } from './stubs';
import type { LocalizationProvider, ProviderId } from './types';

export * from './types';

/** Order = order of the provider switch in the debug panel. */
export const PROVIDER_IDS: ProviderId[] = [
  'manual',
  'reactvision-vps',
  'arcore-cloud-anchor',
  'self-hosted',
];

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
