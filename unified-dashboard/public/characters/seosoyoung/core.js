
(function attachMotionCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SeosoyoungMotionCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMotionCore() {
  'use strict';

  const TAU = Math.PI * 2;
  const STAGE = Object.freeze({ width: 1024, height: 1536 });
  const EYE_BALL_MAX_GAZE_PX = 9;
  const AUTO_GAZE_SEQUENCE = Object.freeze([
    Object.freeze({ x: 0, form: 0, duration: 1.55, transition: 0.16 }),
    Object.freeze({ x: 0.42, form: 0.18, duration: 1.85, transition: 0.2 }),
    Object.freeze({ x: -0.34, form: -0.16, duration: 2.2, transition: 0.19 }),
    Object.freeze({ x: -0.34, form: 0.08, duration: 1.25, transition: 0.14 }),
    Object.freeze({ x: 0.12, form: -0.2, duration: 1.7, transition: 0.17 }),
    Object.freeze({ x: -0.48, form: 0.22, duration: 2.1, transition: 0.21 }),
    Object.freeze({ x: 0, form: 0, duration: 1.7, transition: 0.19 }),
  ]);
  const YAW_DEPTH_FACTORS = Object.freeze({
    skull: 0.56,
    face: 0.62,
    brow: 0.78,
    eye: 0.88,
    mouth: 1.02,
    nose: 1.18,
  });
  const DEFAULT_CONTROLS = Object.freeze({
    autoBlink: true,
    talking: true,
    headMotion: true,
    autoYaw: true,
    yaw: 0,
    autoGaze: true,
    eyeBallX: 0,
    eyeBallForm: 0,
    expression: 'neutral',
    expressionStrength: 1,
    breathing: true,
    wind: 0.7,
    paused: false,
    showMesh: false,
    blinkOverride: null,
    mouthOverride: null,
  });

  function invariant(condition, message) {
    if (!condition) throw new Error(message);
  }

  function clamp(value, low = 0, high = 1) {
    return Math.min(high, Math.max(low, value));
  }

  function mix(a, b, t) {
    return a + (b - a) * t;
  }

  function smoothstep(edge0, edge1, value) {
    if (edge0 === edge1) return value < edge0 ? 0 : 1;
    const t = clamp((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  }

  function positiveModulo(value, modulus) {
    return ((value % modulus) + modulus) % modulus;
  }

  function blinkAt(seconds, enabled = true) {
    if (!enabled) return 0;
    const cycle = 4.6;
    const phase = positiveModulo(seconds + 0.31, cycle);
    const start = 0.08;
    const closeEnd = 0.17;
    const holdEnd = 0.205;
    const openEnd = 0.34;
    if (phase < start || phase >= openEnd) return 0;
    if (phase < closeEnd) return smoothstep(start, closeEnd, phase);
    if (phase < holdEnd) return 1;
    return 1 - smoothstep(holdEnd, openEnd, phase);
  }

  function mouthAt(seconds, enabled = true) {
    if (!enabled) return { open: 0, round: 0 };
    const carrier = 0.5 + 0.5 * Math.sin(TAU * 2.15 * seconds + 0.2 * Math.sin(TAU * 0.47 * seconds));
    const syllable = smoothstep(0.08, 0.92, carrier);
    const open = syllable;
    const round = smoothstep(0.58, 0.96, 0.5 + 0.5 * Math.sin(TAU * 0.73 * seconds + 1.1));
    return { open, round };
  }

  function normalizeControls(input = {}) {
    const controls = { ...DEFAULT_CONTROLS, ...input };
    controls.autoBlink = Boolean(controls.autoBlink);
    controls.talking = Boolean(controls.talking);
    controls.headMotion = Boolean(controls.headMotion);
    controls.autoYaw = Boolean(controls.autoYaw);
    controls.autoGaze = Boolean(controls.autoGaze);
    controls.paused = Boolean(controls.paused);
    controls.showMesh = Boolean(controls.showMesh);
    controls.yaw = clamp(Number.isFinite(controls.yaw) ? controls.yaw : DEFAULT_CONTROLS.yaw, -1, 1);
    controls.eyeBallX = clamp(
      Number.isFinite(controls.eyeBallX) ? controls.eyeBallX : DEFAULT_CONTROLS.eyeBallX,
      -1,
      1,
    );
    controls.eyeBallForm = clamp(
      Number.isFinite(controls.eyeBallForm) ? controls.eyeBallForm : DEFAULT_CONTROLS.eyeBallForm,
      -1,
      1,
    );
    controls.expression = typeof controls.expression === 'string' && /^[a-z0-9-]+$/i.test(controls.expression)
      ? controls.expression
      : DEFAULT_CONTROLS.expression;
    controls.expressionStrength = clamp(
      Number.isFinite(controls.expressionStrength)
        ? controls.expressionStrength
        : DEFAULT_CONTROLS.expressionStrength,
    );
    controls.breathing = Boolean(controls.breathing);
    controls.wind = clamp(Number.isFinite(controls.wind) ? controls.wind : DEFAULT_CONTROLS.wind, 0, 2);
    controls.blinkOverride = Number.isFinite(controls.blinkOverride)
      ? clamp(controls.blinkOverride)
      : null;
    controls.mouthOverride = Number.isFinite(controls.mouthOverride)
      ? clamp(controls.mouthOverride)
      : null;
    return controls;
  }

  function frameAt(seconds, inputControls = {}) {
    invariant(Number.isFinite(seconds), '시간은 유한한 숫자여야 합니다.');
    const controls = normalizeControls(inputControls);
    const blink = controls.blinkOverride === null
      ? blinkAt(seconds, controls.autoBlink)
      : controls.blinkOverride;
    const mouth = mouthAt(seconds, controls.talking);
    const head = headAt(seconds, controls.headMotion);
    const yaw = yawAt(seconds, controls.autoYaw, controls.yaw);
    const eyeBall = eyeBallAt(seconds, controls.autoGaze, controls.eyeBallX, controls.eyeBallForm);
    const breath = breathAt(seconds, controls.breathing);
    if (controls.mouthOverride !== null) mouth.open = controls.mouthOverride;
    if (!controls.talking && controls.mouthOverride === null) mouth.round = 0;
    return Object.freeze({
      seconds,
      blink,
      mouthOpen: clamp(mouth.open),
      mouthRound: clamp(mouth.round),
      headRoll: head.roll,
      headRollDegrees: head.rollDegrees,
      headVelocity: head.velocity,
      yaw,
      yawDegrees: yaw * 8,
      eyeBallX: eyeBall.x,
      eyeBallForm: eyeBall.form,
      expression: controls.expression,
      expressionStrength: controls.expressionStrength,
      breathing: controls.breathing,
      breath,
      browMotion: Math.sin(TAU * 0.31 * seconds + 0.8),
      wind: controls.wind,
      paused: controls.paused,
      showMesh: controls.showMesh,
    });
  }

  function headAt(seconds, enabled = true) {
    if (!enabled) return { roll: 0, rollDegrees: 0, velocity: 0 };
    const primarySpeed = TAU / 5.8;
    const secondarySpeed = TAU / 8.7;
    const primary = 2.7 * Math.PI / 180;
    const secondary = 0.24 * Math.PI / 180;
    const roll = primary * Math.sin(primarySpeed * seconds)
      + secondary * Math.sin(secondarySpeed * seconds + 0.42);
    const velocity = primary * primarySpeed * Math.cos(primarySpeed * seconds)
      + secondary * secondarySpeed * Math.cos(secondarySpeed * seconds + 0.42);
    return { roll, rollDegrees: roll * 180 / Math.PI, velocity };
  }

  function yawAt(seconds, automatic = true, fixedYaw = 0) {
    if (!automatic) return clamp(Number.isFinite(fixedYaw) ? fixedYaw : 0, -1, 1);
    const primary = 0.82 * Math.sin(TAU / 7.4 * seconds + 0.28);
    const secondary = 0.12 * Math.sin(TAU / 11.2 * seconds - 0.61);
    return clamp(primary + secondary, -1, 1);
  }

  function eyeBallScale(form) {
    const amount = clamp(Number.isFinite(form) ? form : 0, -1, 1);
    return amount < 0 ? 1 + amount * 0.15 : 1 + amount * 0.12;
  }

  function eyeBallStageOffset(value) {
    return clamp(Number.isFinite(value) ? value : 0, -1, 1) * EYE_BALL_MAX_GAZE_PX;
  }

  function eyeBallAt(seconds, automatic = true, fixedX = 0, fixedForm = 0) {
    invariant(Number.isFinite(seconds), '눈동자 시간은 유한한 숫자여야 합니다.');
    if (!automatic) {
      return {
        x: clamp(Number.isFinite(fixedX) ? fixedX : 0, -1, 1),
        form: clamp(Number.isFinite(fixedForm) ? fixedForm : 0, -1, 1),
      };
    }
    const cycle = AUTO_GAZE_SEQUENCE.reduce((sum, pose) => sum + pose.duration, 0);
    let phase = positiveModulo(seconds, cycle);
    for (let index = 0; index < AUTO_GAZE_SEQUENCE.length; index += 1) {
      const pose = AUTO_GAZE_SEQUENCE[index];
      if (phase < pose.duration) {
        const previous = AUTO_GAZE_SEQUENCE[(index + AUTO_GAZE_SEQUENCE.length - 1) % AUTO_GAZE_SEQUENCE.length];
        const blend = smoothstep(0, pose.transition, phase);
        return {
          x: mix(previous.x, pose.x, blend),
          form: mix(previous.form, pose.form, blend),
        };
      }
      phase -= pose.duration;
    }
    return { x: 0, form: 0 };
  }

  function yawWarpPoint(x, y, yaw, profile = 'face') {
    invariant(Number.isFinite(x) && Number.isFinite(y), 'yaw 좌표는 유한한 숫자여야 합니다.');
    invariant(Object.hasOwn(YAW_DEPTH_FACTORS, profile), `알 수 없는 yaw 깊이입니다: ${profile}`);
    const amount = clamp(Number.isFinite(yaw) ? yaw : 0, -1, 1);
    const centerX = 512;
    const radius = 360;
    const normalizedX = (x - centerX) / radius;
    if (Math.abs(normalizedX) >= 1 || amount === 0) return { x, y };
    const neckFalloff = 1 - smoothstep(540, 690, y);
    const radialFalloff = 1 - normalizedX * normalizedX;
    const falloff = radialFalloff * neckFalloff;
    const contourScale = 1 - amount * amount * 0.012 * falloff;
    return {
      x: centerX + (x - centerX) * contourScale + amount * 18 * YAW_DEPTH_FACTORS[profile] * falloff,
      y,
    };
  }

  function rotatePoint(x, y, pivotX, pivotY, radians) {
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const offsetX = x - pivotX;
    const offsetY = y - pivotY;
    return {
      x: pivotX + offsetX * cosine - offsetY * sine,
      y: pivotY + offsetX * sine + offsetY * cosine,
    };
  }

  // One stationary point at the neck base is shared by yaw, roll and hair roots.
  const NECK_PIVOT = Object.freeze({ x: 512, y: 690 });

  function headTransformPoint(x, y, frame, profile = 'face') {
    const point = yawWarpPoint(x, y, frame.yaw, profile);
    return rotatePoint(point.x, point.y, NECK_PIVOT.x, NECK_PIVOT.y, frame.headRoll);
  }

  function neckTransformPoint(x, y, frame) {
    const follow = 1 - smoothstep(620, NECK_PIVOT.y, y);
    if (follow === 0) return { x, y };
    const moved = headTransformPoint(x, y, frame);
    return { x: mix(x, moved.x, follow), y: mix(y, moved.y, follow) };
  }

  function breathAt(seconds, enabled = true) {
    if (!enabled) return 0;
    return 0.5 - 0.5 * Math.cos(TAU * seconds / 4.6);
  }

  function breathingPoint(x, y, frame) {
    const breath = clamp(Number.isFinite(frame.breath) ? frame.breath : 0);
    const envelope = smoothstep(720, 820, y) * (1 - smoothstep(1180, 1360, y));
    if (breath === 0 || envelope === 0) return { x, y };
    const amount = breath * envelope;
    const scaleX = 1 + 0.021 * amount;
    return {
      x: 512 + (x - 512) * scaleX,
      y: y - 3.2 * amount,
    };
  }

  function clothingMotionPoint(partId, x, y, frame) {
    invariant(Number.isFinite(x) && Number.isFinite(y), '의상 좌표는 유한한 숫자여야 합니다.');
    const wind = clamp(Number.isFinite(frame.wind) ? frame.wind : 0, 0, 2);
    const seconds = Number.isFinite(frame.seconds) ? frame.seconds : 0;
    if (partId === 'upper-body-short-sleeve') {
      return y <= NECK_PIVOT.y ? neckTransformPoint(x, y, frame) : breathingPoint(x, y, frame);
    }
    if (partId === 'necklace') {
      const weight = Math.pow(smoothstep(687, 842, y), 1.35);
      const phase = TAU * 0.36 * (seconds - 0.16) + 0.45;
      const amplitude = 0.65 + 2.4 * clamp(wind, 0, 1);
      const surface = breathingPoint(x, y, frame);
      return {
        x: surface.x + Math.sin(phase) * amplitude * weight,
        y: surface.y + (1 - Math.cos(phase)) * 0.38 * weight,
      };
    }
    if (partId === 'sweater') {
      const weight = Math.pow(smoothstep(720, 1450, y), 1.25);
      const sideWeight = mix(0.82, 1, clamp(Math.abs(x - 512) / 400));
      const phase = TAU * 0.27 * seconds + (x - 512) / 760;
      const flutter = Math.sqrt(wind / 2);
      const surface = breathingPoint(x, y, frame);
      return {
        x: surface.x + Math.sin(phase) * 12 * flutter * weight * sideWeight,
        y: surface.y + Math.sin(phase * 1.23 + 0.74) * 4 * flutter * weight,
      };
    }
    if (partId === 'skirt') {
      const weight = Math.pow(smoothstep(1340, 1536, y), 1.2);
      const phase = TAU * 0.22 * seconds - 0.38;
      const flutter = Math.sqrt(clamp(wind, 0, 1));
      return {
        x: x + Math.sin(phase) * 4.7 * flutter * weight,
        y: y + Math.sin(phase * 1.17 + 0.9) * 1.4 * flutter * weight,
      };
    }
    throw new Error(`알 수 없는 의상 부품입니다: ${partId}`);
  }

  function partTreeLeafIds(tree, targetId = null) {
    invariant(Array.isArray(tree), '파트 트리는 배열이어야 합니다.');
    function leaves(node) {
      if (!Array.isArray(node.children) || node.children.length === 0) return [node.id];
      return node.children.flatMap(leaves);
    }
    if (targetId === null) return [...new Set(tree.flatMap(leaves))];
    function find(nodes) {
      for (const node of nodes) {
        if (node.id === targetId) return leaves(node);
        const nested = Array.isArray(node.children) ? find(node.children) : null;
        if (nested) return nested;
      }
      return null;
    }
    const result = find(tree);
    invariant(result, `파트 트리에 없는 ID입니다: ${targetId}`);
    return result;
  }

  function updatePartVisibility(tree, current, targetId, visible) {
    const result = Object.fromEntries(
      partTreeLeafIds(tree).map((id) => [id, current?.[id] !== false]),
    );
    partTreeLeafIds(tree, targetId).forEach((id) => { result[id] = Boolean(visible); });
    return result;
  }

  function partVisibilitySummary(tree, visibility, targetId) {
    const ids = partTreeLeafIds(tree, targetId);
    const visibleCount = ids.filter((id) => visibility[id] !== false).length;
    return {
      checked: visibleCount === ids.length,
      indeterminate: visibleCount > 0 && visibleCount < ids.length,
    };
  }

  function gravityCorrectPoint(point, root, frame, weight, strength = 0.64, lagSeconds = 0.14) {
    const amount = clamp(weight);
    const correction = (-frame.headRoll * strength - frame.headVelocity * lagSeconds) * amount;
    return rotatePoint(point.x, point.y, root.x, root.y, correction);
  }

  function frontRoot(u) {
    return 0.235 + 0.055 * Math.cos((u - 0.5) * Math.PI * 1.65);
  }

  function frontGuideU(u, v) {
    const root = frontRoot(u);
    const reach = smoothstep(root, 0.78, v);
    const side = (u - 0.5) * 2;
    return clamp(u + 0.028 * side * (1 - Math.abs(side) * 0.25) * reach);
  }

  function frontHairPoint(u, v, seconds, strength) {
    const guidedU = frontGuideU(u, v);
    const root = frontRoot(guidedU);
    const weight = Math.pow(smoothstep(root, 0.76, v), 1.55);
    const spatialPhase = (guidedU - 0.5) * 2.45 + v * 0.28;
    const phase = TAU * 0.43 * seconds + spatialPhase;
    const amplitude = clamp(strength, 0, 2) * weight;
    const dx = amplitude * (3.2 + 8.8 * weight) * Math.sin(phase);
    const dy = amplitude * (0.8 + 2.4 * weight) * Math.sin(phase * 1.37 + 0.72);
    return { u: guidedU, v, dx, dy, weight, phase };
  }

  function tailHairPoint(u, v, seconds, strength, side) {
    invariant(side === -1 || side === 1, '묶음머리 side는 -1 또는 1이어야 합니다.');
    const root = 0.105 + 0.035 * Math.cos((u - 0.5) * Math.PI);
    const weight = Math.pow(smoothstep(root, 0.92, v), 1.35);
    const phase = TAU * 0.34 * seconds + side * 0.58 + (u - 0.5) * 0.9 + v * 0.22;
    const amplitude = clamp(strength, 0, 2) * weight;
    const dx = side * amplitude * (2.6 + 11.4 * weight) * Math.sin(phase);
    const dy = amplitude * (0.9 + 3.1 * weight) * Math.cos(phase * 1.18 + side * 0.35);
    return { u, v, dx, dy, weight, phase };
  }

  function buildGrid(columns, rows, guide = null) {
    invariant(Number.isInteger(columns) && columns >= 1, 'columns는 1 이상의 정수여야 합니다.');
    invariant(Number.isInteger(rows) && rows >= 1, 'rows는 1 이상의 정수여야 합니다.');
    const vertices = [];
    for (let y = 0; y <= rows; y += 1) {
      const v = y / rows;
      for (let x = 0; x <= columns; x += 1) {
        const sourceU = x / columns;
        const point = guide ? guide(sourceU, v) : { u: sourceU, v };
        vertices.push({ u: point.u, v: point.v, gridU: sourceU, gridV: v, sourceU: point.u, sourceV: point.v });
      }
    }
    const triangles = [];
    const lines = [];
    const stride = columns + 1;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const a = y * stride + x;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        triangles.push(a, c, b, b, c, d);
        lines.push(a, b, a, c);
        if (x === columns - 1) lines.push(b, d);
        if (y === rows - 1) lines.push(c, d);
      }
    }
    return { columns, rows, vertices, triangles, lines };
  }

  function assertBounds(bounds, label = 'stageBounds') {
    invariant(bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y), `${label} 좌표가 필요합니다.`);
    invariant(Number.isFinite(bounds.width) && bounds.width > 0, `${label}.width가 올바르지 않습니다.`);
    invariant(Number.isFinite(bounds.height) && bounds.height > 0, `${label}.height가 올바르지 않습니다.`);
    invariant(bounds.x >= 0 && bounds.y >= 0, `${label}는 스테이지 안이어야 합니다.`);
    invariant(bounds.x + bounds.width <= STAGE.width && bounds.y + bounds.height <= STAGE.height, `${label}가 스테이지를 벗어납니다.`);
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }

  return {
    DEFAULT_CONTROLS,
    AUTO_GAZE_SEQUENCE,
    EYE_BALL_MAX_GAZE_PX,
    STAGE,
    NECK_PIVOT,
    YAW_DEPTH_FACTORS,
    breathAt,
    breathingPoint,
    headTransformPoint,
    neckTransformPoint,
    clothingMotionPoint,
    eyeBallAt,
    eyeBallScale,
    eyeBallStageOffset,
    partTreeLeafIds,
    partVisibilitySummary,
    updatePartVisibility,
    assertBounds,
    blinkAt,
    buildGrid,
    clamp,
    frameAt,
    frontGuideU,
    frontHairPoint,
    gravityCorrectPoint,
    headAt,
    mix,
    mouthAt,
    normalizeControls,
    rotatePoint,
    smoothstep,
    tailHairPoint,
    yawAt,
    yawWarpPoint,
  };
});

  