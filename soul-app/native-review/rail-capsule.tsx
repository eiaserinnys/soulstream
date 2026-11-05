import React from 'react';
import {
  RailCapsuleItem as OriginalRailCapsuleItem,
} from '../src/components/navigation/RailCapsule';
import { recordHomePress } from './home-phase';

export { RailCapsule, RAIL_CAPSULE_WIDTH, RAIL_ITEM_HEIGHT, railCapsuleLength } from '../src/components/navigation/RailCapsule';

// Keep the real native button and its handler; record only an actual press.
export function RailCapsuleItem(props: React.ComponentProps<typeof OriginalRailCapsuleItem>) {
  return <OriginalRailCapsuleItem {...props} onPress={() => {
    props.onPress();
    recordHomePress(props.testID);
  }} />;
}
