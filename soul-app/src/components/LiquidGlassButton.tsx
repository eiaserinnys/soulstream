import React from 'react';
import { GlassButton, type GlassButtonProps } from './GlassSurface';

export type LiquidGlassButtonProps = GlassButtonProps;

export function LiquidGlassButton(props: LiquidGlassButtonProps) {
  return <GlassButton {...props} />;
}
