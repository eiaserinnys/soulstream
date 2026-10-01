import {
  SOURCE_ORBITS_PARAMS,
  SOURCE_WORKING_20_PRESET,
  WORKING_ORB_DOTS,
  WORKING_ORB_PARAMS,
  calculateWorkingOrbDot,
} from '../thinkingOrbGeometry';

describe('thinking-orbs working/orbits 20px port', () => {
  it('ports the source constants and the count/size preset transforms', () => {
    expect(SOURCE_ORBITS_PARAMS).toEqual({
      orbitN: 12,
      ghostN: 40,
      ghostR: 0.9,
      ghostA: 0.5,
      particles: 3,
      partR: 1.2,
      partRDepth: 1.6,
      rsPow: 0.6,
      rMin: 0.3,
    });
    expect(SOURCE_WORKING_20_PRESET).toEqual({
      speed: 3.9,
      count: 0.238,
      size: 2.4,
    });
    expect(WORKING_ORB_PARAMS).toEqual({
      orbitN: 3,
      ghostN: 10,
      ghostR: 2.16,
      ghostA: 0.5,
      particles: 3,
      partR: 2.88,
      partRDepth: 3.84,
      rsPow: 0.6,
      rMin: 0.3,
    });
  });

  it('pre-mounts every effective source dot without sampling or omission', () => {
    expect(WORKING_ORB_DOTS).toHaveLength(39);
    expect(WORKING_ORB_DOTS.filter((dot) => dot.kind === 'ghost')).toHaveLength(30);
    expect(WORKING_ORB_DOTS.filter((dot) => dot.kind === 'particle')).toHaveLength(9);
    expect(new Set(WORKING_ORB_DOTS.map((dot) => dot.id)).size).toBe(39);
  });

  it.each([
    {
      s: 0,
      orbitIndex: 0,
      kind: 'ghost' as const,
      dotIndex: 0,
      expected: {
        x: 5.957114677111518,
        y: 3.7684290439064636,
        z: 1.9276507887342285,
        depth: 0.6255930641015288,
        radius: 0.42540147922504,
        white: 0.72,
        opacity: 0.3876779192304587,
      },
    },
    {
      s: 0.6,
      orbitIndex: 2,
      kind: 'ghost' as const,
      dotIndex: 9,
      expected: {
        x: 8.404647158866265,
        y: 6.749118767015494,
        z: -1.1996225759972925,
        depth: 0.3427660874012187,
        radius: 0.42540147922504,
        white: 0.72,
        opacity: 0.30282982622036564,
      },
    },
    {
      s: 0,
      orbitIndex: 0,
      kind: 'particle' as const,
      dotIndex: 0,
      expected: {
        x: 8.713014597928534,
        y: 10.66756641991541,
        z: -7.535997580149531,
        depth: 0.009003895993954736,
        radius: 0.5740113423882608,
        white: 0.29801914288132997,
        opacity: 1,
      },
    },
    {
      s: 1.234,
      orbitIndex: 2,
      kind: 'particle' as const,
      dotIndex: 2,
      expected: {
        x: 12.0508545410678,
        y: 12.594498708008171,
        z: -1.9013274071164679,
        depth: 0.2507939969338382,
        radius: 0.7568697719025687,
        white: 0.2448253206745556,
        opacity: 1,
      },
    },
  ])('matches the original renderer output for $kind $orbitIndex:$dotIndex at s=$s', ({
    s,
    orbitIndex,
    kind,
    dotIndex,
    expected,
  }) => {
    const actual = calculateWorkingOrbDot(s, orbitIndex, kind, dotIndex);

    for (const [key, value] of Object.entries(expected)) {
      expect(actual[key as keyof typeof actual]).toBeCloseTo(value, 12);
    }
  });
});
