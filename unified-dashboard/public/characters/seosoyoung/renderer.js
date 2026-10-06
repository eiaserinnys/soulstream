
(function attachWebGLRenderer(root, factory) {
  const api = factory(root.SeosoyoungMotionCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SeosoyoungWebGLRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRendererApi(core) {
  'use strict';

  if (!core) throw new Error('모션 코어를 불러오지 못했습니다.');

  const TEXTURE_VERTEX = `
    attribute vec2 a_position;
    attribute vec2 a_uv;
    uniform vec2 u_stage;
    varying vec2 v_uv;
    void main() {
      vec2 clip = vec2(a_position.x / u_stage.x * 2.0 - 1.0, 1.0 - a_position.y / u_stage.y * 2.0);
      gl_Position = vec4(clip, 0.0, 1.0);
      v_uv = a_uv;
    }
  `;

  const TEXTURE_FRAGMENT = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform sampler2D u_clip_texture;
    uniform float u_opacity;
    uniform float u_eye_mask;
    uniform float u_clip_mask;
    uniform float u_eye_motion;
    uniform vec2 u_eye_center;
    uniform float u_eye_gaze;
    uniform float u_eye_scale;
    uniform float u_blink;
    varying vec2 v_uv;
    void main() {
      vec2 sampleUv = v_uv;
      if (u_eye_motion > 0.5) {
        sampleUv = u_eye_center + (v_uv - u_eye_center - vec2(u_eye_gaze, 0.0)) / u_eye_scale;
      }
      vec4 color = texture2D(u_texture, sampleUv);
      float visibility = u_opacity;
      if (u_clip_mask > 0.5) {
        visibility *= texture2D(u_clip_texture, v_uv).a;
      }
      if (u_eye_mask > 0.5 && u_blink > 0.001) {
        float eyeCenter = v_uv.x < 0.5 ? 0.266 : 0.748;
        float edge = clamp(abs(v_uv.x - eyeCenter) / 0.145, 0.0, 1.0);
        float lid = mix(0.285, 0.885, smoothstep(0.0, 1.0, u_blink));
        float curve = lid - 0.065 * edge * edge;
        float belowLid = smoothstep(curve - 0.018, curve + 0.018, v_uv.y);
        visibility *= mix(1.0, belowLid, smoothstep(0.035, 0.32, u_blink));
        visibility *= 1.0 - smoothstep(0.72, 1.0, u_blink);
      }
      gl_FragColor = color * visibility;
    }
  `;

  const LINE_VERTEX = `
    attribute vec2 a_position;
    uniform vec2 u_stage;
    void main() {
      vec2 clip = vec2(a_position.x / u_stage.x * 2.0 - 1.0, 1.0 - a_position.y / u_stage.y * 2.0);
      gl_Position = vec4(clip, 0.0, 1.0);
    }
  `;

  const LINE_FRAGMENT = `
    precision mediump float;
    uniform vec4 u_color;
    void main() { gl_FragColor = u_color; }
  `;

  function shader(gl, type, source) {
    const value = gl.createShader(type);
    gl.shaderSource(value, source);
    gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(value);
      gl.deleteShader(value);
      throw new Error(`WebGL shader 오류: ${message}`);
    }
    return value;
  }

  function program(gl, vertexSource, fragmentSource) {
    const value = gl.createProgram();
    const vertex = shader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = shader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(value, vertex);
    gl.attachShader(value, fragment);
    gl.linkProgram(value);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(value, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(value);
      gl.deleteProgram(value);
      throw new Error(`WebGL program 오류: ${message}`);
    }
    return value;
  }

  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function compose(images, ids, nativeSize) {
    const canvas = makeCanvas(nativeSize[0], nativeSize[1]);
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    ids.forEach((id) => {
      const image = images.get(id);
      if (!image) throw new Error(`합성할 부품이 없습니다: ${id}`);
      if (image.naturalWidth !== canvas.width || image.naturalHeight !== canvas.height) {
        throw new Error(`${id} native 크기가 부모와 다릅니다.`);
      }
      context.drawImage(image, 0, 0);
    });
    return canvas;
  }

  function nativeRectForStageRect(parent, stageRect) {
    const scaleX = parent.nativeSize[0] / parent.stageBounds.width;
    const scaleY = parent.nativeSize[1] / parent.stageBounds.height;
    return [
      Math.max(0, Math.floor((stageRect[0] - parent.stageBounds.x) * scaleX)),
      Math.max(0, Math.floor((stageRect[1] - parent.stageBounds.y) * scaleY)),
      Math.min(parent.nativeSize[0], Math.ceil((stageRect[2] - parent.stageBounds.x) * scaleX)),
      Math.min(parent.nativeSize[1], Math.ceil((stageRect[3] - parent.stageBounds.y) * scaleY)),
    ];
  }

  function averageScleraTone(source, nativeRect, verticalStart, verticalEnd, fallback) {
    const canvas = makeCanvas(source.naturalWidth, source.naturalHeight);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    const [left, top, right, bottom] = nativeRect;
    const data = context.getImageData(left, top, right - left, bottom - top).data;
    const height = bottom - top;
    const yStart = Math.floor(height * verticalStart);
    const yEnd = Math.ceil(height * verticalEnd);
    let red = 0;
    let green = 0;
    let blue = 0;
    let weight = 0;
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = 0; x < right - left; x += 1) {
        const offset = (y * (right - left) + x) * 4;
        const alpha = data[offset + 3] / 255;
        const luminance = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
        if (alpha < 0.2 || luminance < 155) continue;
        red += data[offset] * alpha;
        green += data[offset + 1] * alpha;
        blue += data[offset + 2] * alpha;
        weight += alpha;
      }
    }
    if (weight === 0) return fallback;
    return [Math.round(red / weight), Math.round(green / weight), Math.round(blue / weight)];
  }

  function rgb(tone) {
    return `rgb(${tone[0]}, ${tone[1]}, ${tone[2]})`;
  }

  function alphaBoundsCenter(source, nativeRect, fallback) {
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    const [left, top, right, bottom] = nativeRect;
    const sampleWidth = right - left;
    const sampleHeight = bottom - top;
    const data = context.getImageData(left, top, sampleWidth, sampleHeight).data;
    let minX = sampleWidth;
    let minY = sampleHeight;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < sampleHeight; y += 1) {
      for (let x = 0; x < sampleWidth; x += 1) {
        if (data[(y * sampleWidth + x) * 4 + 3] <= 8) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX < minX || maxY < minY) return fallback;
    return [
      (left + (minX + maxX + 1) * 0.5) / width,
      (top + (minY + maxY + 1) * 0.5) / height,
    ];
  }

  function makeScleraHoleMask(mask, sclera) {
    const width = mask.width;
    const height = mask.height;
    const maskContext = mask.getContext('2d', { willReadFrequently: true });
    const maskData = maskContext.getImageData(0, 0, width, height);
    const scleraCanvas = makeCanvas(width, height);
    const scleraContext = scleraCanvas.getContext('2d', { willReadFrequently: true });
    scleraContext.drawImage(sclera, 0, 0);
    const scleraData = scleraContext.getImageData(0, 0, width, height).data;
    for (let offset = 0; offset < maskData.data.length; offset += 4) {
      const scleraAlpha = scleraData[offset + 3] / 255;
      const preserveOriginal = core.smoothstep(0.04, 0.24, scleraAlpha);
      maskData.data[offset] = 255;
      maskData.data[offset + 1] = 255;
      maskData.data[offset + 2] = 255;
      maskData.data[offset + 3] = Math.round(maskData.data[offset + 3] * (1 - preserveOriginal));
    }
    const holeMask = makeCanvas(width, height);
    holeMask.getContext('2d').putImageData(maskData, 0, 0);
    return holeMask;
  }

  function makeNeutralEyeSources(images, eyeMotion, eyeParent) {
    const result = {};
    ['left', 'right'].forEach((side) => {
      const scleraId = `eye-${side}-sclera`;
      const movingIds = [
        `eye-${side}-highlight`,
        `eye-${side}-pupil`,
        `eye-${side}-iris`,
      ];
      const maskIds = [scleraId, ...movingIds];
      const moving = compose(images, movingIds, eyeParent.nativeSize);
      const mask = compose(images, maskIds, eyeParent.nativeSize);
      const source = images.get(scleraId);
      const nativeRect = nativeRectForStageRect(eyeParent, eyeMotion.openVisualStageBounds[side]);
      const middleTone = averageScleraTone(source, nativeRect, 0, 1, [249, 239, 239]);
      const topTone = averageScleraTone(source, nativeRect, 0, 0.52, middleTone);
      const bottomTone = averageScleraTone(source, nativeRect, 0.48, 1, middleTone);
      const fill = makeCanvas(eyeParent.nativeSize[0], eyeParent.nativeSize[1]);
      const context = fill.getContext('2d');
      context.drawImage(makeScleraHoleMask(mask, source), 0, 0);
      context.globalCompositeOperation = 'source-in';
      const gradient = context.createLinearGradient(0, nativeRect[1], 0, nativeRect[3]);
      gradient.addColorStop(0, rgb(topTone));
      gradient.addColorStop(1, rgb(bottomTone));
      context.fillStyle = gradient;
      context.fillRect(0, 0, fill.width, fill.height);
      const stageRect = eyeMotion.openVisualStageBounds[side];
      const openingCenterUv = [
        ((stageRect[0] + stageRect[2]) * 0.5 - eyeParent.stageBounds.x) / eyeParent.stageBounds.width,
        ((stageRect[1] + stageRect[3]) * 0.5 - eyeParent.stageBounds.y) / eyeParent.stageBounds.height,
      ];
      result[side] = {
        scleraId,
        movingIds,
        moving,
        mask,
        fill,
        centerUv: alphaBoundsCenter(moving, nativeRect, openingCenterUv),
      };
    });
    return result;
  }

  function composeEyeFills(eyeSources, visibleIds, nativeSize) {
    const visible = new Set(visibleIds);
    const canvas = makeCanvas(nativeSize[0], nativeSize[1]);
    const context = canvas.getContext('2d');
    ['left', 'right'].forEach((side) => {
      if (visible.has(eyeSources[side].scleraId)) context.drawImage(eyeSources[side].fill, 0, 0);
    });
    return canvas;
  }

  const INWARD_EYE_RECTS = Object.freeze({
    surprised: Object.freeze({ left: [250, 220, 500, 470], right: [770, 220, 1020, 470] }),
    happy: Object.freeze({ left: [250, 230, 500, 420], right: [770, 230, 1020, 420] }),
    embarrassed: Object.freeze({ left: [250, 200, 510, 415], right: [780, 200, 1030, 415] }),
  });

  function cropCanvas(source, rect) {
    const width = rect[2] - rect[0];
    const height = rect[3] - rect[1];
    const canvas = makeCanvas(width, height);
    canvas.getContext('2d').drawImage(source, rect[0], rect[1], width, height, 0, 0, width, height);
    return canvas;
  }

  function stationaryEyeDetails(source, rects) {
    const canvas = makeCanvas(source.naturalWidth, source.naturalHeight);
    const context = canvas.getContext('2d');
    context.drawImage(source, 0, 0);
    Object.values(rects).forEach((rect) => {
      context.clearRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
    });
    return canvas;
  }

  function stageBoundsForNativeRect(asset, rect, offsetX) {
    const scaleX = asset.stageBounds.width / asset.nativeSize.width;
    const scaleY = asset.stageBounds.height / asset.nativeSize.height;
    return {
      x: asset.stageBounds.x + rect[0] * scaleX + offsetX,
      y: asset.stageBounds.y + rect[1] * scaleY,
      width: (rect[2] - rect[0]) * scaleX,
      height: (rect[3] - rect[1]) * scaleY,
    };
  }

  class MotionRenderer {
    constructor(canvas, manifest, images) {
      this.canvas = canvas;
      this.manifest = manifest;
      this.images = images;
      this.layers = [];
      this.textureCount = 0;
      this.expressionDefinitions = new Map(
        (manifest.expressionSet || []).map((definition) => [definition.id, definition]),
      );
      this.clothingDefinitions = new Map(
        (manifest.clothingSet || []).map((definition) => [definition.id, definition]),
      );
      this.partVisibility = new Map();
      this.groupLeafIds = new Map();
      this.textureRevision = 0;
      this.registerPartTree(manifest.partTree || []);
      this.gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: true,
        depth: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
      });
      if (!this.gl) throw new Error('이 브라우저에서 WebGL을 시작할 수 없습니다.');
      this.setupGl();
      this.buildLayers();
    }

    registerPartTree(tree) {
      const visit = (node) => {
        if (!Array.isArray(node.children) || node.children.length === 0) {
          this.partVisibility.set(node.id, true);
          return [node.id];
        }
        const ids = node.children.flatMap(visit);
        this.groupLeafIds.set(node.id, ids);
        return ids;
      };
      tree.forEach(visit);
    }

    isPartVisible(id) {
      return this.partVisibility.get(id) !== false;
    }

    isGroupVisible(id) {
      const ids = this.groupLeafIds.get(id) || [];
      return ids.some((leafId) => this.isPartVisible(leafId));
    }

    updateTexture(layer, source) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, layer.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.textureRevision += 1;
    }

    setPartVisibility(next) {
      const changed = new Set();
      Object.entries(next || {}).forEach(([id, visible]) => {
        if (!this.partVisibility.has(id)) return;
        const normalized = Boolean(visible);
        if (this.partVisibility.get(id) !== normalized) {
          this.partVisibility.set(id, normalized);
          changed.add(id);
        }
      });
      if (changed.size === 0) return { changed: [], textureUpdates: 0 };
      const before = this.textureRevision;
      this.layers.forEach((layer) => {
        if (!layer.compositeLeafIds?.some((id) => changed.has(id))) return;
        const visibleIds = layer.compositeLeafIds.filter((id) => this.isPartVisible(id));
        const source = layer.compositeFactory
          ? layer.compositeFactory(visibleIds)
          : compose(this.images, visibleIds, layer.compositeNativeSize);
        this.updateTexture(layer, source);
      });
      return { changed: [...changed], textureUpdates: this.textureRevision - before };
    }

    setupGl() {
      const gl = this.gl;
      this.textureProgram = program(gl, TEXTURE_VERTEX, TEXTURE_FRAGMENT);
      this.lineProgram = program(gl, LINE_VERTEX, LINE_FRAGMENT);
      this.textureLocations = {
        position: gl.getAttribLocation(this.textureProgram, 'a_position'),
        uv: gl.getAttribLocation(this.textureProgram, 'a_uv'),
        stage: gl.getUniformLocation(this.textureProgram, 'u_stage'),
        texture: gl.getUniformLocation(this.textureProgram, 'u_texture'),
        clipTexture: gl.getUniformLocation(this.textureProgram, 'u_clip_texture'),
        opacity: gl.getUniformLocation(this.textureProgram, 'u_opacity'),
        eyeMask: gl.getUniformLocation(this.textureProgram, 'u_eye_mask'),
        clipMask: gl.getUniformLocation(this.textureProgram, 'u_clip_mask'),
        eyeMotion: gl.getUniformLocation(this.textureProgram, 'u_eye_motion'),
        eyeCenter: gl.getUniformLocation(this.textureProgram, 'u_eye_center'),
        eyeGaze: gl.getUniformLocation(this.textureProgram, 'u_eye_gaze'),
        eyeScale: gl.getUniformLocation(this.textureProgram, 'u_eye_scale'),
        blink: gl.getUniformLocation(this.textureProgram, 'u_blink'),
      };
      this.lineLocations = {
        position: gl.getAttribLocation(this.lineProgram, 'a_position'),
        stage: gl.getUniformLocation(this.lineProgram, 'u_stage'),
        color: gl.getUniformLocation(this.lineProgram, 'u_color'),
      };
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      this.resize();
    }

    resize() {
      if (this.canvas.width !== core.STAGE.width) this.canvas.width = core.STAGE.width;
      if (this.canvas.height !== core.STAGE.height) this.canvas.height = core.STAGE.height;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    makeTexture(source) {
      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.textureCount += 1;
      return texture;
    }

    makeLayer({
      id,
      source,
      bounds,
      z,
      grid,
      deformation = 'static',
      side = 0,
      eyeMask = false,
      clipSource = null,
      eyeMotionCenter = null,
      neutralEye = false,
      headAttached = false,
      rootAnchor = null,
      expressionId = null,
      expressionKind = null,
      browSide = null,
      clothingId = null,
      yawProfile = null,
      treeLeafId = null,
      treeGroupId = null,
      compositeLeafIds = null,
      compositeNativeSize = null,
      compositeFactory = null,
    }) {
      const gl = this.gl;
      const mesh = grid || core.buildGrid(headAttached ? 8 : 1, headAttached ? 8 : 1);
      const uv = new Float32Array(mesh.vertices.flatMap((vertex) => [vertex.sourceU, vertex.sourceV]));
      const layer = {
        id,
        bounds: core.assertBounds(bounds, `${id}.stageBounds`),
        z,
        mesh,
        deformation,
        side,
        eyeMask,
        clipTexture: clipSource ? this.makeTexture(clipSource) : null,
        eyeMotionCenter,
        neutralEye,
        headAttached,
        rootAnchor,
        expressionId,
        expressionKind,
        browSide,
        clothingId,
        yawProfile,
        treeLeafId,
        treeGroupId,
        compositeLeafIds,
        compositeNativeSize,
        compositeFactory,
        texture: this.makeTexture(source),
        positionBuffer: gl.createBuffer(),
        uvBuffer: gl.createBuffer(),
        triangleBuffer: gl.createBuffer(),
        lineBuffer: gl.createBuffer(),
        positions: new Float32Array(mesh.vertices.length * 2),
      };
      gl.bindBuffer(gl.ARRAY_BUFFER, layer.uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, layer.triangleBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.triangles), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, layer.lineBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.lines), gl.STATIC_DRAW);
      this.layers.push(layer);
      return layer;
    }

    parent(id) {
      const parent = this.manifest.parents.find((value) => value.id === id);
      if (!parent) throw new Error(`부모 기록이 없습니다: ${id}`);
      return parent;
    }

    expression(id) {
      const record = this.manifest.expressions.find((value) => value.id === id);
      if (!record || !this.images.has(id)) throw new Error(`표정 입력이 없습니다: ${id}`);
      return record;
    }

    hasExpression(id) {
      return id === 'neutral' || this.expressionDefinitions.has(id);
    }

    expressionDefinition(frame) {
      return this.expressionDefinitions.get(frame.expression) || null;
    }

    expressionMix(frame) {
      return this.expressionDefinitions.has(frame.expression) ? frame.expressionStrength : 0;
    }

    buildStaticParent(parentId, zOffset = 0, headAttached = false, yawProfile = null) {
      const parent = this.parent(parentId);
      const source = compose(this.images, parent.leafIds, parent.nativeSize);
      return this.makeLayer({
        id: parentId,
        source,
        bounds: parent.stageBounds,
        z: parent.z + zOffset,
        headAttached,
        yawProfile,
        compositeLeafIds: parent.leafIds,
        compositeNativeSize: parent.nativeSize,
      });
    }

    buildLayers() {
      this.buildStaticParent('back-hair', 0, true, 'skull');
      const bodyParent = this.parent('body-neck');
      const clothingOrder = ['upper-body-short-sleeve', 'skirt', 'sweater', 'necklace'];
      this.clothingLayers = clothingOrder.map((id, index) => {
        const definition = this.clothingDefinitions.get(id);
        if (!definition) throw new Error(`의상 입력이 없습니다: ${id}`);
        return this.makeLayer({
          id: `clothing-${id}`,
          source: this.images.get(definition.imageId),
          bounds: definition.stageBounds,
          z: bodyParent.z + index * 0.1,
          grid: core.buildGrid(16, 48),
          deformation: 'clothing',
          clothingId: id,
          treeLeafId: id,
        });
      });
      this.buildStaticParent('face-base', 0, true, 'face');

      const eyeParent = this.parent('eyes-brows');
      const eyeMotion = this.manifest.motion.eyes;
      const eyeSources = makeNeutralEyeSources(this.images, eyeMotion, eyeParent);
      const scleraLeafIds = ['left', 'right'].map((side) => eyeSources[side].scleraId);
      const movingLeafIds = new Set(['left', 'right'].flatMap((side) => eyeSources[side].movingIds));
      const lineLeafIds = eyeMotion.openLeafIds.filter((id) => !movingLeafIds.has(id) && !scleraLeafIds.includes(id));
      this.eyeWhiteBase = this.makeLayer({
        id: 'eyes-open-white-base',
        source: composeEyeFills(eyeSources, scleraLeafIds, eyeParent.nativeSize),
        bounds: eyeParent.stageBounds,
        z: eyeParent.z,
        eyeMask: true,
        neutralEye: true,
        headAttached: true,
        yawProfile: 'eye',
        compositeLeafIds: scleraLeafIds,
        compositeNativeSize: eyeParent.nativeSize,
        compositeFactory: (visibleIds) => composeEyeFills(eyeSources, visibleIds, eyeParent.nativeSize),
      });
      this.eyeWhiteOriginal = this.makeLayer({
        id: 'eyes-open-white-original',
        source: compose(this.images, scleraLeafIds, eyeParent.nativeSize),
        bounds: eyeParent.stageBounds,
        z: eyeParent.z + 0.005,
        eyeMask: true,
        neutralEye: true,
        headAttached: true,
        yawProfile: 'eye',
        compositeLeafIds: scleraLeafIds,
        compositeNativeSize: eyeParent.nativeSize,
      });
      this.eyeMoving = ['left', 'right'].map((side, index) => this.makeLayer({
        id: `eyes-open-moving-${side}`,
        source: eyeSources[side].moving,
        bounds: eyeParent.stageBounds,
        z: eyeParent.z + 0.01 + index * 0.001,
        eyeMask: true,
        clipSource: eyeSources[side].mask,
        eyeMotionCenter: eyeSources[side].centerUv,
        neutralEye: true,
        headAttached: true,
        yawProfile: 'eye',
        compositeLeafIds: eyeSources[side].movingIds,
        compositeNativeSize: eyeParent.nativeSize,
      }));
      this.eyeLinesFixed = this.makeLayer({
        id: 'eyes-open-fixed-lines',
        source: compose(this.images, lineLeafIds, eyeParent.nativeSize),
        bounds: eyeParent.stageBounds,
        z: eyeParent.z + 0.02,
        eyeMask: true,
        neutralEye: true,
        headAttached: true,
        yawProfile: 'eye',
        compositeLeafIds: lineLeafIds,
        compositeNativeSize: eyeParent.nativeSize,
      });
      this.eyeOpenLayers = [this.eyeWhiteBase, this.eyeWhiteOriginal, ...this.eyeMoving, this.eyeLinesFixed];
      const closed = this.expression(eyeMotion.closedExpressionId);
      this.eyeClosed = this.makeLayer({
        id: 'eyes-closed',
        source: this.images.get(closed.id),
        bounds: closed.stageBounds,
        z: eyeParent.z + 0.35,
        headAttached: true,
        yawProfile: 'eye',
        treeGroupId: 'eyes',
      });
      this.expressionDefinitions.forEach((definition) => {
        const source = this.images.get(definition.eyes.imageId);
        const rects = INWARD_EYE_RECTS[definition.id];
        const z = this.parent('hair-cap').z + 0.2;
        if (!rects) {
          this.makeLayer({
            id: `expression-${definition.id}-eyes`,
            source,
            bounds: definition.eyes.stageBounds,
            z,
            eyeMask: false,
            headAttached: true,
            yawProfile: 'eye',
            expressionId: definition.id,
            expressionKind: 'eyes',
            treeGroupId: 'eyes',
          });
          return;
        }
        this.makeLayer({
          id: `expression-${definition.id}-eye-details`,
          source: stationaryEyeDetails(source, rects),
          bounds: definition.eyes.stageBounds,
          z,
          headAttached: true,
          yawProfile: 'face',
          expressionId: definition.id,
          expressionKind: 'eyes',
          treeGroupId: 'eyes',
        });
        ['left', 'right'].forEach((side, index) => {
          const rect = rects[side];
          this.makeLayer({
            id: `expression-${definition.id}-eye-${side}`,
            source: cropCanvas(source, rect),
            bounds: stageBoundsForNativeRect(definition.eyes, rect, side === 'left' ? 8 : -8),
            z: z + 0.01 + index * 0.01,
            headAttached: true,
            yawProfile: 'eye',
            expressionId: definition.id,
            expressionKind: 'eyes',
            treeGroupId: 'eyes',
          });
        });
      });
      this.eyeBrowLeft = this.makeLayer({
        id: 'eyebrow-left',
        source: compose(this.images, [eyeMotion.browLeafIds[0]], eyeParent.nativeSize),
        bounds: eyeParent.stageBounds,
        z: eyeParent.z + 0.45,
        deformation: 'brow',
        headAttached: true,
        browSide: 'left',
        yawProfile: 'brow',
        compositeLeafIds: [eyeMotion.browLeafIds[0]],
        compositeNativeSize: eyeParent.nativeSize,
      });
      this.eyeBrowRight = this.makeLayer({
        id: 'eyebrow-right',
        source: compose(this.images, [eyeMotion.browLeafIds[1]], eyeParent.nativeSize),
        bounds: eyeParent.stageBounds,
        z: eyeParent.z + 0.46,
        deformation: 'brow',
        headAttached: true,
        browSide: 'right',
        yawProfile: 'brow',
        compositeLeafIds: [eyeMotion.browLeafIds[1]],
        compositeNativeSize: eyeParent.nativeSize,
      });

      this.buildStaticParent('nose', 0, true, 'nose');

      const mouthParent = this.parent('mouth');
      const mouthMotion = this.manifest.motion.mouth;
      this.mouthClosed = this.makeLayer({
        id: 'mouth-closed',
        source: this.images.get(mouthMotion.closedLeafId),
        bounds: mouthParent.stageBounds,
        z: mouthParent.z,
        headAttached: true,
        yawProfile: 'mouth',
        treeLeafId: mouthMotion.closedLeafId,
        treeGroupId: 'mouth',
      });
      this.expressionDefinitions.forEach((definition) => {
        this.makeLayer({
          id: `expression-${definition.id}-mouth`,
          source: this.images.get(definition.mouth.imageId),
          bounds: definition.mouth.stageBounds,
          z: mouthParent.z + 0.05,
          deformation: 'expression-mouth',
          headAttached: true,
          yawProfile: 'mouth',
          expressionId: definition.id,
          expressionKind: 'mouth',
          treeGroupId: 'mouth',
        });
      });
      const mouthOpen = this.expression(mouthMotion.openExpressionId);
      this.mouthOpen = this.makeLayer({
        id: 'mouth-open',
        source: this.images.get(mouthOpen.id),
        bounds: mouthOpen.stageBounds,
        z: mouthParent.z + 0.1,
        grid: core.buildGrid(6, 4),
        deformation: 'mouth',
        headAttached: true,
        yawProfile: 'mouth',
        treeGroupId: 'mouth',
      });
      const mouthRound = this.expression(mouthMotion.roundExpressionId);
      this.mouthRound = this.makeLayer({
        id: 'mouth-round',
        source: this.images.get(mouthRound.id),
        bounds: mouthRound.stageBounds,
        z: mouthParent.z + 0.2,
        grid: core.buildGrid(6, 4),
        deformation: 'mouth-round',
        headAttached: true,
        yawProfile: 'mouth',
        treeGroupId: 'mouth',
      });

      this.manifest.motion.ponytails.forEach((motion) => {
        const parent = this.parent(motion.parentId);
        const grid = core.buildGrid(motion.mesh.columns, motion.mesh.rows);
        this.makeLayer({
          id: `${motion.parentId}-hair`,
          source: this.images.get(motion.hairLeafId),
          bounds: parent.stageBounds,
          z: parent.z,
          grid,
          deformation: 'tail',
          side: motion.side,
          headAttached: true,
          yawProfile: 'skull',
          rootAnchor: motion.side < 0 ? { x: 309, y: 545 } : { x: 690, y: 544 },
          treeLeafId: motion.hairLeafId,
        });
        this.makeLayer({
          id: `${motion.parentId}-tie`,
          source: this.images.get(motion.tieLeafId),
          bounds: parent.stageBounds,
          z: parent.z + 0.1,
          headAttached: true,
          yawProfile: 'skull',
          treeLeafId: motion.tieLeafId,
        });
      });

      const front = this.manifest.motion.frontHair;
      const hairParent = this.parent(front.parentId);
      this.hairFixed = this.makeLayer({
        id: 'hair-cap-fixed',
        source: compose(this.images, front.fixedLeafIds, hairParent.nativeSize),
        bounds: hairParent.stageBounds,
        z: hairParent.z,
        headAttached: true,
        yawProfile: 'skull',
        compositeLeafIds: front.fixedLeafIds,
        compositeNativeSize: hairParent.nativeSize,
      });
      const frontGrid = core.buildGrid(
        front.mesh.columns,
        front.mesh.rows,
        (u, v) => ({ u: core.frontGuideU(u, v), v }),
      );
      this.frontHair = this.makeLayer({
        id: 'front-hair-connected',
        source: compose(this.images, front.movingLeafIds, hairParent.nativeSize),
        bounds: hairParent.stageBounds,
        z: hairParent.z + 0.1,
        grid: frontGrid,
        deformation: 'front',
        headAttached: true,
        rootAnchor: { x: 512, y: 170 },
        yawProfile: 'skull',
        compositeLeafIds: front.movingLeafIds,
        compositeNativeSize: hairParent.nativeSize,
      });

      this.layers.sort((a, b) => a.z - b.z);
    }

    layerOpacity(layer, frame) {
      if (layer.treeLeafId && !this.isPartVisible(layer.treeLeafId)) return 0;
      if (layer.treeGroupId && !this.isGroupVisible(layer.treeGroupId)) return 0;
      const expressionMix = this.expressionMix(frame);
      if (layer === this.eyeClosed) return (1 - expressionMix) * core.smoothstep(0.48, 0.88, frame.blink);
      if (layer === this.eyeBrowLeft || layer === this.eyeBrowRight || layer.id === 'nose') return 1 - expressionMix;
      if (layer.neutralEye) return 1 - expressionMix;
      const mouthVisible = core.smoothstep(0.055, 0.22, frame.mouthOpen);
      if (layer === this.mouthClosed) return (1 - expressionMix) * (1 - mouthVisible);
      if (layer.expressionKind === 'eyes') {
        return layer.expressionId === frame.expression ? expressionMix : 0;
      }
      if (layer.expressionKind === 'mouth') {
        return layer.expressionId === frame.expression ? expressionMix : 0;
      }
      if (layer === this.mouthOpen) return (1 - expressionMix) * mouthVisible * (1 - frame.mouthRound * 0.46);
      if (layer === this.mouthRound) return (1 - expressionMix) * mouthVisible * frame.mouthRound * 0.46;
      return 1;
    }

    updatePositions(layer, frame) {
      const { bounds, mesh, positions } = layer;
      mesh.vertices.forEach((vertex, index) => {
        let u = vertex.u;
        let v = vertex.v;
        let dx = 0;
        let dy = 0;
        let gravityWeight = 0;
        if (layer.deformation === 'front') {
          const point = core.frontHairPoint(vertex.gridU, vertex.gridV, frame.seconds, frame.wind);
          u = point.u;
          v = point.v;
          dx = point.dx;
          dy = point.dy;
          gravityWeight = point.weight;
        } else if (layer.deformation === 'tail') {
          const point = core.tailHairPoint(vertex.u, vertex.v, frame.seconds, frame.wind, layer.side);
          dx = point.dx;
          dy = point.dy;
          gravityWeight = point.weight;
        } else if (layer.deformation === 'mouth' || layer.deformation === 'mouth-round') {
          const amount = frame.mouthOpen;
          const roundBias = layer.deformation === 'mouth-round' ? 1 : 0;
          const scaleX = core.mix(0.76, roundBias ? 0.94 : 1.0, amount);
          const scaleY = core.mix(0.14, roundBias ? 1.28 : 1.42, amount);
          u = 0.5 + (u - 0.5) * scaleX;
          v = 0.5 + (v - 0.5) * scaleY;
        } else if (layer.deformation === 'expression-mouth') {
          const mouthCenterV = (554 - bounds.y) / bounds.height;
          const scaleY = 1 + frame.mouthOpen * this.expressionMix(frame) * 0.055;
          v = mouthCenterV + (v - mouthCenterV) * scaleY;
        }
        let point = {
          x: bounds.x + u * bounds.width + dx,
          y: bounds.y + v * bounds.height + dy,
        };
        if (layer.deformation === 'brow') {
          const definition = this.expressionDefinition(frame);
          const pose = definition?.browPose?.[layer.browSide];
          if (pose) {
            const strength = this.expressionMix(frame);
            const radians = Number(pose.rotationDegrees || 0) * strength * Math.PI / 180;
            point = core.rotatePoint(point.x, point.y, pose.pivot[0], pose.pivot[1], radians);
            point.x += Number(pose.dx || 0) * strength;
            point.y += Number(pose.dy || 0) * strength + frame.browMotion * 0.65 * strength;
          }
        }
        if (layer.clothingId) {
          point = core.clothingMotionPoint(layer.clothingId, point.x, point.y, frame);
        } else if (layer.headAttached) {
          point = core.headTransformPoint(point.x, point.y, frame, layer.yawProfile || 'face');
        }
        if (layer.rootAnchor && gravityWeight > 0) {
          const root = core.headTransformPoint(layer.rootAnchor.x, layer.rootAnchor.y, frame, layer.yawProfile || 'face');
          point = core.gravityCorrectPoint(point, root, frame, gravityWeight);
        }
        positions[index * 2] = point.x;
        positions[index * 2 + 1] = point.y;
      });
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, layer.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    }

    drawTexture(layer, frame) {
      const gl = this.gl;
      const locations = this.textureLocations;
      this.updatePositions(layer, frame);
      gl.useProgram(this.textureProgram);
      gl.uniform2f(locations.stage, core.STAGE.width, core.STAGE.height);
      gl.uniform1f(locations.opacity, this.layerOpacity(layer, frame));
      gl.uniform1f(locations.eyeMask, layer.eyeMask ? 1 : 0);
      gl.uniform1f(locations.clipMask, layer.clipTexture ? 1 : 0);
      gl.uniform1f(locations.eyeMotion, layer.eyeMotionCenter ? 1 : 0);
      gl.uniform2fv(locations.eyeCenter, layer.eyeMotionCenter || [0.5, 0.5]);
      gl.uniform1f(locations.eyeGaze, layer.eyeMotionCenter ? core.eyeBallStageOffset(frame.eyeBallX) / layer.bounds.width : 0);
      gl.uniform1f(locations.eyeScale, layer.eyeMotionCenter ? core.eyeBallScale(frame.eyeBallForm) : 1);
      gl.uniform1f(locations.blink, frame.blink);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layer.texture);
      gl.uniform1i(locations.texture, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, layer.clipTexture || layer.texture);
      gl.uniform1i(locations.clipTexture, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, layer.positionBuffer);
      gl.enableVertexAttribArray(locations.position);
      gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, layer.uvBuffer);
      gl.enableVertexAttribArray(locations.uv);
      gl.vertexAttribPointer(locations.uv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, layer.triangleBuffer);
      gl.drawElements(gl.TRIANGLES, layer.mesh.triangles.length, gl.UNSIGNED_SHORT, 0);
    }

    drawMesh(layer) {
      if (!['front', 'tail', 'mouth', 'mouth-round', 'expression-mouth'].includes(layer.deformation) && layer.id !== 'face-base') return;
      const gl = this.gl;
      const locations = this.lineLocations;
      gl.useProgram(this.lineProgram);
      gl.uniform2f(locations.stage, core.STAGE.width, core.STAGE.height);
      const front = layer.deformation === 'front';
      gl.uniform4f(locations.color, front ? 0.0 : 0.95, front ? 0.55 : 0.26, front ? 1.0 : 0.6, 0.42);
      gl.bindBuffer(gl.ARRAY_BUFFER, layer.positionBuffer);
      gl.enableVertexAttribArray(locations.position);
      gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, layer.lineBuffer);
      gl.drawElements(gl.LINES, layer.mesh.lines.length, gl.UNSIGNED_SHORT, 0);
    }

    render(frame) {
      const gl = this.gl;
      this.resize();
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.layers.forEach((layer) => this.drawTexture(layer, frame));
      if (frame.showMesh) this.layers.forEach((layer) => this.drawMesh(layer));
      return {
        layerCount: this.layers.length,
        textureCount: this.textureCount,
        frontMeshVertices: this.frontHair.mesh.vertices.length,
        frontMeshTriangles: this.frontHair.mesh.triangles.length / 3,
        expressionCount: this.expressionDefinitions.size,
        clothingCount: this.clothingDefinitions.size,
        textureRevision: this.textureRevision,
      };
    }
  }

  return { MotionRenderer, compose };
});

  