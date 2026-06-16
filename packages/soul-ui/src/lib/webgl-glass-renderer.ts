import { calculateBackingDpr, type PackedGlassSurfaces } from "./webgl-glass";
import {
  DEFAULT_LIQUID_GLASS_SETTINGS,
  normalizeLiquidGlassSettings,
  type LiquidGlassSettings,
} from "./glass-settings";
import { WEBGL_GLASS_FRAGMENT_SHADER, WEBGL_GLASS_VERTEX_SHADER } from "./webgl-glass-shaders";
import {
  drawDashboardWallpaper,
  type WallpaperRenderInput,
} from "./webgl-glass-wallpaper";

const DEFAULT_RADIUS = 22;
const MAX_TEXTURE_SIDE = 4096;

interface Uniforms {
  uRes: WebGLUniformLocation | null;
  uBg: WebGLUniformLocation | null;
  uCount: WebGLUniformLocation | null;
  uCards: WebGLUniformLocation | null;
  uRadius: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uScale: WebGLUniformLocation | null;
  uBlur: WebGLUniformLocation | null;
  uAb: WebGLUniformLocation | null;
  uRim: WebGLUniformLocation | null;
  uGlass: WebGLUniformLocation | null;
}

export interface WebglGlassRenderer {
  resize(): boolean;
  updateSettings(settings: LiquidGlassSettings): void;
  updateWallpaper(input: Omit<WallpaperRenderInput, "width" | "height">): void;
  render(packed: PackedGlassSurfaces): void;
  destroy(): void;
}

export function createWebglGlassRenderer(canvas: HTMLCanvasElement): WebglGlassRenderer | null {
  const gl = getWebgl2Context(canvas);
  if (!gl) return null;

  const program = createProgram(gl);
  if (!program) return null;
  const vao = gl.createVertexArray();
  const bgTexture = gl.createTexture();
  if (!vao || !bgTexture) return null;

  const uniforms = getUniforms(gl, program);
  gl.useProgram(program);
  gl.bindVertexArray(vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, bgTexture);
  gl.uniform1i(uniforms.uBg, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  let dpr = 1.5;
  let lastWallpaper: Omit<WallpaperRenderInput, "width" | "height"> | null = null;
  let glassSettings = DEFAULT_LIQUID_GLASS_SETTINGS;

  const renderer: WebglGlassRenderer = {
    resize() {
      const nextDpr = calculateBackingDpr(window.devicePixelRatio || 1);
      const width = Math.max(1, Math.floor(window.innerWidth * nextDpr));
      const height = Math.max(1, Math.floor(window.innerHeight * nextDpr));
      const changed = canvas.width !== width || canvas.height !== height || dpr !== nextDpr;
      if (!changed) return false;
      dpr = nextDpr;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      if (lastWallpaper) uploadWallpaperTexture(gl, bgTexture, lastWallpaper, width, height);
      return true;
    },
    updateSettings(settings) {
      glassSettings = normalizeLiquidGlassSettings(settings);
    },
    updateWallpaper(input) {
      lastWallpaper = input;
      uploadWallpaperTexture(gl, bgTexture, input, canvas.width || 1, canvas.height || 1);
    },
    render(packed) {
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bgTexture);
      gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
      gl.uniform1f(uniforms.uDpr, dpr);
      gl.uniform1i(uniforms.uCount, packed.count);
      gl.uniform4fv(uniforms.uCards, packed.rects);
      gl.uniform1f(uniforms.uRadius, DEFAULT_RADIUS);
      gl.uniform1f(uniforms.uScale, glassSettings.refraction);
      gl.uniform1f(uniforms.uBlur, glassSettings.blur);
      gl.uniform1f(uniforms.uAb, glassSettings.chromatic);
      gl.uniform1f(uniforms.uRim, glassSettings.specular);
      gl.uniform1f(uniforms.uGlass, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      gl.deleteTexture(bgTexture);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };

  renderer.resize();
  uploadSolidTexture(gl, bgTexture, [13, 15, 21, 255]);
  return renderer;
}

function getWebgl2Context(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  try {
    return canvas.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: false,
      alpha: true,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, WEBGL_GLASS_VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, WEBGL_GLASS_FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("Liquid glass WebGL program link failed", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("Liquid glass WebGL shader compile failed", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function getUniforms(gl: WebGL2RenderingContext, program: WebGLProgram): Uniforms {
  return {
    uRes: gl.getUniformLocation(program, "uRes"),
    uBg: gl.getUniformLocation(program, "uBg"),
    uCount: gl.getUniformLocation(program, "uCount"),
    uCards: gl.getUniformLocation(program, "uCards"),
    uRadius: gl.getUniformLocation(program, "uRadius"),
    uDpr: gl.getUniformLocation(program, "uDpr"),
    uScale: gl.getUniformLocation(program, "uScale"),
    uBlur: gl.getUniformLocation(program, "uBlur"),
    uAb: gl.getUniformLocation(program, "uAb"),
    uRim: gl.getUniformLocation(program, "uRim"),
    uGlass: gl.getUniformLocation(program, "uGlass"),
  };
}

function uploadWallpaperTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  input: Omit<WallpaperRenderInput, "width" | "height">,
  backingWidth: number,
  backingHeight: number,
): void {
  const textureSize = calculateTextureSize(backingWidth, backingHeight);
  const canvas = document.createElement("canvas");
  canvas.width = textureSize.width;
  canvas.height = textureSize.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  drawDashboardWallpaper(context, {
    ...input,
    width: textureSize.width,
    height: textureSize.height,
  });

  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  } catch (error) {
    console.warn("Liquid glass wallpaper texture upload failed", error);
    uploadSolidTexture(gl, texture, [13, 15, 21, 255]);
  }
}

function uploadSolidTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  rgba: [number, number, number, number],
): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array(rgba),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

function calculateTextureSize(backingWidth: number, backingHeight: number): { width: number; height: number } {
  const width = Math.max(1, Math.floor(backingWidth));
  const height = Math.max(1, Math.floor(backingHeight));
  const scale = Math.min(1, MAX_TEXTURE_SIDE / Math.max(width, height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
