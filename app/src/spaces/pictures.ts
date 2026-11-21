/**
 * A picture of each space, for its card and its sheet on the Spaces screen. They are the
 * renders that came with the space's files (`assets/environments/<space>/preview/`), made
 * from the shipped model; a space without one gets a plain tile.
 */
import type { ImageSourcePropType } from 'react-native';

import type { EnvironmentId } from '../state/appStore';

export const SPACE_PICTURE: Record<EnvironmentId, ImageSourcePropType | null> = {
  sponza: require('../../assets/environments/sponza_atrium/preview/3_in_the_court.jpg') as ImageSourcePropType,
  'test-room': null,
};
