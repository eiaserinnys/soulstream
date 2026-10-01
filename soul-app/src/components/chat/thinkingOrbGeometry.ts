/**
 * thinking-orbs by Jakub Antalik, MIT.
 * Parameters and the `orbits` renderer mathematics are ported from thinking-orbs@0.2.0.
 */

export const THINKING_ORB_SIZE = 20;

export const SOURCE_ORBITS_PARAMS = {
  orbitN: 12,
  ghostN: 40,
  ghostR: 0.9,
  ghostA: 0.5,
  particles: 3,
  partR: 1.2,
  partRDepth: 1.6,
  rsPow: 0.6,
  rMin: 0.3,
} as const;

export const SOURCE_WORKING_20_PRESET = {
  speed: 3.9,
  count: 0.238,
  size: 2.4,
} as const;

const scaleCount = (value: number) =>
  Math.max(1, Math.round(value * SOURCE_WORKING_20_PRESET.count));

// thinking-orbs Bt() scales only the named count fields; `particles` is unchanged.
// Ot() then scales the radius fields by the 20px preset's size multiplier.
export const WORKING_ORB_PARAMS = {
  orbitN: scaleCount(SOURCE_ORBITS_PARAMS.orbitN),
  ghostN: scaleCount(SOURCE_ORBITS_PARAMS.ghostN),
  ghostR: SOURCE_ORBITS_PARAMS.ghostR * SOURCE_WORKING_20_PRESET.size,
  ghostA: SOURCE_ORBITS_PARAMS.ghostA,
  particles: SOURCE_ORBITS_PARAMS.particles,
  partR: SOURCE_ORBITS_PARAMS.partR * SOURCE_WORKING_20_PRESET.size,
  partRDepth: SOURCE_ORBITS_PARAMS.partRDepth * SOURCE_WORKING_20_PRESET.size,
  rsPow: SOURCE_ORBITS_PARAMS.rsPow,
  rMin: SOURCE_ORBITS_PARAMS.rMin,
} as const;

export type WorkingOrbDotKind = 'ghost' | 'particle';

export interface WorkingOrbDotDescriptor {
  id: string;
  orbitIndex: number;
  kind: WorkingOrbDotKind;
  dotIndex: number;
}

export interface WorkingOrbDotFrame {
  x: number;
  y: number;
  z: number;
  depth: number;
  radius: number;
  white: number;
  opacity: number;
}

export const WORKING_ORB_DOTS: readonly WorkingOrbDotDescriptor[] = Array.from(
  { length: WORKING_ORB_PARAMS.orbitN },
  (_, orbitIndex) => [
    ...Array.from({ length: WORKING_ORB_PARAMS.ghostN }, (_, dotIndex) => ({
      id: `ghost-${orbitIndex}-${dotIndex}`,
      orbitIndex,
      kind: 'ghost' as const,
      dotIndex,
    })),
    ...Array.from({ length: WORKING_ORB_PARAMS.particles }, (_, dotIndex) => ({
      id: `particle-${orbitIndex}-${dotIndex}`,
      orbitIndex,
      kind: 'particle' as const,
      dotIndex,
    })),
  ],
).flat();

export const WORKING_ORB_MAX_RADIUS = Math.max(
  WORKING_ORB_PARAMS.rMin,
  (WORKING_ORB_PARAMS.partR + WORKING_ORB_PARAMS.partRDepth) *
    (THINKING_ORB_SIZE / 300) ** WORKING_ORB_PARAMS.rsPow,
);

function sourceHash(index: number, seed: number) {
  'worklet';
  const value = Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * Direct port of thinking-orbs@0.2.0's `orbits` renderer before rasterization.
 * `s` is the source renderer time: performance.now() / 1000 * preset speed.
 */
export function calculateWorkingOrbDot(
  s: number,
  orbitIndex: number,
  kind: WorkingOrbDotKind,
  dotIndex: number,
): WorkingOrbDotFrame {
  'worklet';

  const centerX = THINKING_ORB_SIZE / 2;
  const centerY = THINKING_ORB_SIZE / 2;
  const baseRadius = (THINKING_ORB_SIZE / 2) * 0.82;
  const radiusScale =
    (THINKING_ORB_SIZE / 300) ** WORKING_ORB_PARAMS.rsPow;

  const randomRadius = sourceHash(orbitIndex, 1.7);
  const randomTilt = sourceHash(orbitIndex, 5.2);
  const randomDirection = sourceHash(orbitIndex, 8.9);
  const orbitRadius = baseRadius * (0.45 + 0.52 * randomRadius);
  const azimuth = randomRadius * 2 * Math.PI;
  const polar = Math.acos(2 * randomTilt - 1);
  const planeX = Math.sin(polar) * Math.cos(azimuth);
  const planeY = Math.cos(polar);
  const planeZ = Math.sin(polar) * Math.sin(azimuth);

  let axisAX = -planeY;
  let axisAY = planeX;
  const axisAZ = 0;
  const axisALength = Math.max(
    1e-6,
    Math.sqrt(axisAX * axisAX + axisAY * axisAY),
  );
  axisAX /= axisALength;
  axisAY /= axisALength;

  const axisBX = planeY * axisAZ - planeZ * axisAY;
  const axisBY = planeZ * axisAX - planeX * axisAZ;
  const axisBZ = planeX * axisAY - planeY * axisAX;
  const orbitSpeed =
    (0.25 + 0.55 * randomDirection) *
    (randomDirection > 0.5 ? 1 : -1);
  const angle = kind === 'ghost'
    ? (dotIndex / WORKING_ORB_PARAMS.ghostN) * 2 * Math.PI
    : s * orbitSpeed +
      (dotIndex / WORKING_ORB_PARAMS.particles) * 2 * Math.PI +
      randomTilt * 6;

  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  const pointX = (axisAX * cosAngle + axisBX * sinAngle) * orbitRadius;
  const pointY = (axisAY * cosAngle + axisBY * sinAngle) * orbitRadius;
  const pointZ = (axisAZ * cosAngle + axisBZ * sinAngle) * orbitRadius;

  // Direct port of the source camera: $(s * 0.12, 0.3, centerX, centerY, 1).
  const cameraYaw = s * 0.12;
  const cameraTilt = 0.3;
  const sinYaw = Math.sin(cameraYaw);
  const cosYaw = Math.cos(cameraYaw);
  const sinTilt = Math.sin(cameraTilt);
  const cosTilt = Math.cos(cameraTilt);
  const rotatedX = pointX * cosYaw + pointZ * sinYaw;
  const rotatedZ = -pointX * sinYaw + pointZ * cosYaw;
  const tiltedY = pointY * cosTilt - rotatedZ * sinTilt;
  const depthZ = pointY * sinTilt + rotatedZ * cosTilt;
  const depth = (depthZ / orbitRadius + 1) / 2;

  if (kind === 'ghost') {
    return {
      x: centerX + rotatedX,
      y: centerY - tiltedY,
      z: depthZ,
      depth,
      radius: Math.max(
        WORKING_ORB_PARAMS.rMin,
        WORKING_ORB_PARAMS.ghostR * radiusScale,
      ),
      white: 0.72,
      opacity: WORKING_ORB_PARAMS.ghostA * (0.4 + 0.6 * depth),
    };
  }

  return {
    x: centerX + rotatedX,
    y: centerY - tiltedY,
    z: depthZ,
    depth,
    radius: Math.max(
      WORKING_ORB_PARAMS.rMin,
      (WORKING_ORB_PARAMS.partR + WORKING_ORB_PARAMS.partRDepth * depth) *
        radiusScale,
    ),
    white: 0.3 - 0.22 * depth,
    opacity: 1,
  };
}
