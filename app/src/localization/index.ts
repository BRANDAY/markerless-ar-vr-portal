import { ManualPlacementProvider } from './ManualPlacementProvider';
import { SelfHostedServerProvider } from './SelfHostedServerProvider';
import { ArCoreCloudAnchorProvider, ReactVisionVpsProvider } from './stubs';
import type { LocalizationProvider, ProviderId } from './types';

export * from './types';

/** Every provider the app knows, including the two that are only stubs. */
export const PROVIDER_IDS: ProviderId[] = [
  'manual',
  'reactvision-vps',
  'arcore-cloud-anchor',
  'self-hosted',
];

/**
 * The providers the "Provider" button of the debug panel switches between, in that order.
 * The stubs (`reactvision-vps`, `arcore-cloud-anchor`) are left out: choosing one only
 * removed the door and showed "not implemented".
 */
export const SELECTABLE_PROVIDER_IDS: ProviderId[] = ['manual', 'self-hosted'];

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
