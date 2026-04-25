/**
 * WebGL2 renderer for the EU4 map.
 *
 * Two render paths:
 *   Vector (when vectorsUrl provided): triangulated province polygons + line borders.
 *     Resolution-independent at any zoom level.
 *   Raster (fallback): full-screen textured quad with province_id texture + LUT.
 *
 * Province picking always uses the CPU-decoded ids array from provinces_id.png.
 */

import earcut from "earcut";

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  provincesUrl: string;   // provinces_id.png — always needed for picking
  vectorsUrl?: string;    // province_vectors.bin — enables vector render path
  bordersUrl?: string;    // province_borders.png — raster path only
  maxProvinces: number;
}

export interface MapRenderer {
  setOwnerColors(data: Uint8Array): void;
  provinceIdAtClient(clientX: number, clientY: number): number;
  texToClient(u: number, v: number): { x: number; y: number };
  getZoom(): number;
  onViewChange(cb: () => void): () => void;
  destroy(): void;
  fit(): void;
}

// ─── Binary vector format parser ────────────────────────────────────────────

interface ProvinceRings {
  pid: number;
  rings: Float32Array[];
}

function parseVectorBin(buffer: ArrayBuffer): ProvinceRings[] {
  const view = new DataView(buffer);
  let off = 0;

  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (magic !== "PV01") throw new Error("Invalid vector file magic");
  off = 4;

  /* const imgW = */ view.getUint32(off, true); off += 4;
  /* const imgH = */ view.getUint32(off, true); off += 4;
  const numEntries = view.getUint32(off, true); off += 4;

  const provinces: ProvinceRings[] = [];

  for (let i = 0; i < numEntries; i++) {
    const pid = view.getUint16(off, true); off += 2;
    const numRings = view.getUint16(off, true); off += 2;
    const rings: Float32Array[] = [];

    for (let r = 0; r < numRings; r++) {
      const numPts = view.getUint16(off, true); off += 2;
      off += 2; // padding — keeps float data 4-byte aligned
      // Zero-copy view into the ArrayBuffer.
      rings.push(new Float32Array(buffer, off, numPts * 2));
      off += numPts * 8;
    }
    provinces.push({ pid, rings });
  }
  return provinces;
}

// ─── Geometry builder (earcut triangulation) ────────────────────────────────

interface Geometry {
  vertices: Float32Array;  // x, y, pid — 3 floats per vertex
  polyIndices: Uint32Array;
}

function buildGeometry(provinces: ProvinceRings[]): Geometry {
  // Pre-count for single allocation.
  let totalVerts = 0;
  let totalPolyIdx = 0;
  for (const { rings } of provinces) {
    for (const ring of rings) {
      const n = ring.length / 2;
      totalVerts += n;
      totalPolyIdx += n * 3; // worst-case earcut output
    }
  }

  const vertices = new Float32Array(totalVerts * 3);
  const polyIdx = new Uint32Array(totalPolyIdx);
  let vOff = 0;
  let pOff = 0;
  let baseVertex = 0;

  for (const { pid, rings } of provinces) {
    // Each ring is an independent polygon (outer boundary or island).
    // Never treat siblings as holes — EU4 has no province holes, only
    // disconnected island parts that happen to share the same province ID.
    for (const ring of rings) {
      const numPts = ring.length / 2;
      if (numPts < 3) continue;

      const flat = Array.from(ring);
      const tris = earcut(flat, undefined, 2);
      if (tris.length === 0) continue;

      for (let i = 0; i < numPts; i++) {
        vertices[vOff++] = flat[i * 2];
        vertices[vOff++] = flat[i * 2 + 1];
        vertices[vOff++] = pid;
      }
      for (const idx of tris) polyIdx[pOff++] = baseVertex + idx;
      baseVertex += numPts;
    }
  }

  return {
    vertices: vertices.subarray(0, vOff),
    polyIndices: polyIdx.subarray(0, pOff),
  };
}

// ─── Main renderer factory ───────────────────────────────────────────────────

export async function createRenderer(opts: RendererOptions): Promise<MapRenderer> {
  const { canvas } = opts;
  const glOrNull = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!glOrNull) throw new Error("WebGL2 not supported");
  const gl: WebGL2RenderingContext = glOrNull;

  // Always load provinces_id.png — needed for CPU-side picking.
  const img = await loadImage(opts.provincesUrl);
  const texW = img.naturalWidth;
  const texH = img.naturalHeight;

  const offscreen = document.createElement("canvas");
  offscreen.width = texW; offscreen.height = texH;
  const ctx2d = offscreen.getContext("2d", { willReadFrequently: true })!;
  ctx2d.drawImage(img, 0, 0);
  const imgData = ctx2d.getImageData(0, 0, texW, texH).data;
  const ids = new Uint16Array(texW * texH);
  for (let i = 0, j = 0; i < ids.length; i++, j += 4) {
    ids[i] = (imgData[j] << 8) | imgData[j + 1];
  }

  // Attempt to load vector data.
  let vectorGeo: Geometry | null = null;
  if (opts.vectorsUrl) {
    try {
      const resp = await fetch(opts.vectorsUrl);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        const provinces = parseVectorBin(buf);
        vectorGeo = buildGeometry(provinces);
      }
    } catch (e) {
      console.warn("Vector load failed, falling back to raster:", e);
    }
  }

  // ── LUT texture ─────────────────────────────────────────────────────────
  const lutW = opts.maxProvinces + 1;
  const lutTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lutW, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(lutW * 4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // ── Shared vertex shader snippets ────────────────────────────────────────
  // Both paths share the same view uniforms.
  const VIEW_UNIFORMS = `
    uniform vec2 u_viewScale;
    uniform vec2 u_viewOffset;
  `;
  const UV_FROM_POS = `
    vec2 clipFromUV(vec2 uv) {
      return vec2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) * u_viewScale + u_viewOffset;
    }
  `;

  // ── Border texture (used in both render paths) ────────────────────────────
  let borderTex: WebGLTexture | null = null;
  let hasBorder = false;
  if (opts.bordersUrl) {
    try {
      const bimg = await loadImage(opts.bordersUrl);
      borderTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, borderTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, bimg.naturalWidth, bimg.naturalHeight, 0, gl.RED, gl.UNSIGNED_BYTE, bimg as unknown as TexImageSource);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      hasBorder = true;
    } catch (e) {
      console.warn("border mask load failed", e);
    }
  }

  // Shared border overlay quad — used in both vector and raster paths.
  const borderOverlayVS = `#version 300 es
    in vec2 a_pos;
    ${VIEW_UNIFORMS}
    out vec2 v_uv;
    void main() {
      v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
      gl_Position = vec4(a_pos * u_viewScale + u_viewOffset, 0.0, 1.0);
    }
  `;
  const borderOverlayFS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    uniform sampler2D u_borders;
    uniform vec2 u_texelSize;
    out vec4 outColor;
    void main() {
      if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) discard;
      float b1 = texture(u_borders, v_uv).r;
      float b2 = texture(u_borders, v_uv + vec2(u_texelSize.x, 0.0)).r;
      float b3 = texture(u_borders, v_uv + vec2(0.0, u_texelSize.y)).r;
      float b4 = texture(u_borders, v_uv + u_texelSize).r;
      float b = 0.25 * (b1 + b2 + b3 + b4);
      float alpha = b * 0.65;
      if (alpha < 0.01) discard;
      outColor = vec4(0.0, 0.0, 0.0, alpha);
    }
  `;
  const borderProgram = linkProgram(gl, borderOverlayVS, borderOverlayFS);
  const bp_uViewScale  = gl.getUniformLocation(borderProgram, "u_viewScale");
  const bp_uViewOffset = gl.getUniformLocation(borderProgram, "u_viewOffset");
  const bp_uBorders    = gl.getUniformLocation(borderProgram, "u_borders");
  const bp_uTexelSize  = gl.getUniformLocation(borderProgram, "u_texelSize");

  const quadBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
  const borderQuadVAO = gl.createVertexArray()!;
  gl.bindVertexArray(borderQuadVAO);
  const bqPos = gl.getAttribLocation(borderProgram, "a_pos");
  gl.enableVertexAttribArray(bqPos);
  gl.vertexAttribPointer(bqPos, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // ── VECTOR render path ───────────────────────────────────────────────────
  let polyProgram: WebGLProgram | null = null;
  let polyVAO: WebGLVertexArrayObject | null = null;
  let polyCount = 0;

  let vp_uViewScale: WebGLUniformLocation | null = null;
  let vp_uViewOffset: WebGLUniformLocation | null = null;
  let vp_uLut: WebGLUniformLocation | null = null;
  let vp_uLutW: WebGLUniformLocation | null = null;

  if (vectorGeo) {
    const polyVS = `#version 300 es
      layout(location=0) in vec2 a_uv;
      layout(location=1) in float a_pid;
      ${VIEW_UNIFORMS}
      ${UV_FROM_POS}
      flat out float v_pid;
      void main() {
        v_pid = a_pid;
        gl_Position = vec4(clipFromUV(a_uv), 0.0, 1.0);
      }
    `;
    const polyFS = `#version 300 es
      precision highp float;
      flat in float v_pid;
      uniform sampler2D u_lut;
      uniform float u_lutW;
      out vec4 outColor;
      void main() {
        int pid = int(v_pid + 0.5);
        float u = (float(pid) + 0.5) / u_lutW;
        outColor = texture(u_lut, vec2(u, 0.5));
      }
    `;

    polyProgram = linkProgram(gl, polyVS, polyFS);
    vp_uViewScale = gl.getUniformLocation(polyProgram, "u_viewScale");
    vp_uViewOffset = gl.getUniformLocation(polyProgram, "u_viewOffset");
    vp_uLut = gl.getUniformLocation(polyProgram, "u_lut");
    vp_uLutW = gl.getUniformLocation(polyProgram, "u_lutW");

    const vtxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vtxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, vectorGeo.vertices, gl.STATIC_DRAW);

    const polyIdxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, polyIdxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, vectorGeo.polyIndices, gl.STATIC_DRAW);
    polyCount = vectorGeo.polyIndices.length;

    polyVAO = gl.createVertexArray()!;
    gl.bindVertexArray(polyVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, vtxBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, polyIdxBuf);
    gl.bindVertexArray(null);
  }

  // ── RASTER render path ───────────────────────────────────────────────────
  let rasterProgram: WebGLProgram | null = null;
  let rasterVAO: WebGLVertexArrayObject | null = null;
  let rasterProvTex: WebGLTexture | null = null;
  let rp_uViewScale: WebGLUniformLocation | null = null;
  let rp_uViewOffset: WebGLUniformLocation | null = null;
  let rp_uProv: WebGLUniformLocation | null = null;
  let rp_uLut: WebGLUniformLocation | null = null;
  let rp_uLutW: WebGLUniformLocation | null = null;
  let rp_uBord: WebGLUniformLocation | null = null;
  let rp_uHasBord: WebGLUniformLocation | null = null;
  let rp_uTexelSize: WebGLUniformLocation | null = null;

  if (!vectorGeo) {
    // Province texture for display.
    rasterProvTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, rasterProvTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const rasterVS = `#version 300 es
      in vec2 a_pos;
      ${VIEW_UNIFORMS}
      out vec2 v_uv;
      void main() {
        v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
        gl_Position = vec4(a_pos * u_viewScale + u_viewOffset, 0.0, 1.0);
      }
    `;
    const rasterFS = `#version 300 es
      precision highp float;
      precision highp int;
      in vec2 v_uv;
      uniform sampler2D u_provinces;
      uniform sampler2D u_lut;
      uniform sampler2D u_borders;
      uniform float u_lutW;
      uniform float u_hasBorder;
      uniform vec2 u_texelSize;
      out vec4 outColor;
      vec4 lutColor(vec2 uv) {
        vec4 px = texture(u_provinces, uv);
        int id = int(px.r * 255.0 + 0.5) * 256 + int(px.g * 255.0 + 0.5);
        float u = (float(id) + 0.5) / u_lutW;
        return texture(u_lut, vec2(u, 0.5));
      }
      void main() {
        if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
          outColor = vec4(0.05, 0.05, 0.08, 1.0); return;
        }
        vec4 base = lutColor(v_uv);
        if (u_hasBorder > 0.5) {
          float b1 = texture(u_borders, v_uv).r;
          float b2 = texture(u_borders, v_uv + vec2(u_texelSize.x, 0.0)).r;
          float b3 = texture(u_borders, v_uv + vec2(0.0, u_texelSize.y)).r;
          float b4 = texture(u_borders, v_uv + u_texelSize).r;
          float border = 0.25 * (b1 + b2 + b3 + b4);
          base.rgb = mix(base.rgb, base.rgb * 0.55, border * 0.7);
        }
        outColor = base;
      }
    `;

    rasterProgram = linkProgram(gl, rasterVS, rasterFS);
    rp_uViewScale = gl.getUniformLocation(rasterProgram, "u_viewScale");
    rp_uViewOffset = gl.getUniformLocation(rasterProgram, "u_viewOffset");
    rp_uProv = gl.getUniformLocation(rasterProgram, "u_provinces");
    rp_uLut = gl.getUniformLocation(rasterProgram, "u_lut");
    rp_uLutW = gl.getUniformLocation(rasterProgram, "u_lutW");
    rp_uBord = gl.getUniformLocation(rasterProgram, "u_borders");
    rp_uHasBord = gl.getUniformLocation(rasterProgram, "u_hasBorder");
    rp_uTexelSize = gl.getUniformLocation(rasterProgram, "u_texelSize");

    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    rasterVAO = gl.createVertexArray()!;
    gl.bindVertexArray(rasterVAO);
    const aPos = gl.getAttribLocation(rasterProgram, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  // ── Pan / zoom state ─────────────────────────────────────────────────────
  const texAspect = texW / texH;
  let zoom = 1;
  let centerX = 0.5;
  let centerY = 0.5;

  function computeView() {
    const canvasW = canvas.clientWidth || 1;
    const canvasH = canvas.clientHeight || 1;
    const viewAspect = canvasW / canvasH;
    const sx = (texAspect / viewAspect) * zoom;
    const sy = zoom;
    const ox = (0.5 - centerX) * 2 * sx;
    const oy = -(0.5 - centerY) * 2 * sy;
    return { sx, sy, ox, oy };
  }

  function fit() {
    const canvasW = canvas.clientWidth || 1;
    const canvasH = canvas.clientHeight || 1;
    const viewAspect = canvasW / canvasH;
    zoom = texAspect > viewAspect ? 1 : Math.min(viewAspect / texAspect, 1);
    zoom = Math.min(zoom, 1.0);
    centerX = 0.5; centerY = 0.5;
    render();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    // Vector mode: true device pixels (crisp). Raster mode: ×3 SSAA.
    const scale = vectorGeo ? dpr : dpr * 3;
    const w = Math.floor((canvas.clientWidth || 1) * scale);
    const h = Math.floor((canvas.clientHeight || 1) * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function render() {
    resize();
    const { sx, sy, ox, oy } = computeView();

    gl.clearColor(0.05, 0.05, 0.08, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (vectorGeo && polyProgram && polyVAO) {
      // ── Vector path ──────────────────────────────────────────────────────
      gl.disable(gl.BLEND);
      gl.useProgram(polyProgram);
      gl.uniform2f(vp_uViewScale, sx, sy);
      gl.uniform2f(vp_uViewOffset, ox, oy);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      gl.uniform1i(vp_uLut, 0);
      gl.uniform1f(vp_uLutW, lutW);
      gl.bindVertexArray(polyVAO);
      gl.drawElements(gl.TRIANGLES, polyCount, gl.UNSIGNED_INT, 0);

      // Border overlay (alpha-blended full-screen quad).
      if (hasBorder) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(borderProgram);
        gl.uniform2f(bp_uViewScale, sx, sy);
        gl.uniform2f(bp_uViewOffset, ox, oy);
        gl.uniform2f(bp_uTexelSize, 1 / texW, 1 / texH);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, borderTex);
        gl.uniform1i(bp_uBorders, 0);
        gl.bindVertexArray(borderQuadVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.disable(gl.BLEND);
      }

    } else if (rasterProgram && rasterVAO) {
      // ── Raster path ──────────────────────────────────────────────────────
      gl.disable(gl.BLEND);
      gl.useProgram(rasterProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, rasterProvTex);
      gl.uniform1i(rp_uProv, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      gl.uniform1i(rp_uLut, 1);
      gl.uniform1f(rp_uLutW, lutW);
      gl.uniform2f(rp_uTexelSize, 1 / texW, 1 / texH);
      gl.uniform1f(rp_uHasBord, hasBorder ? 1.0 : 0.0);
      if (hasBorder) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, borderTex);
        gl.uniform1i(rp_uBord, 2);
      }
      gl.uniform2f(rp_uViewScale, sx, sy);
      gl.uniform2f(rp_uViewOffset, ox, oy);
      gl.bindVertexArray(rasterVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    notifyView();
  }

  // ── Mouse interactions ───────────────────────────────────────────────────
  const ro = new ResizeObserver(() => render());
  ro.observe(canvas);

  let dragging = false;
  let lastX = 0, lastY = 0;

  canvas.addEventListener("mousedown", (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.style.cursor = "grabbing";
  });
  window.addEventListener("mouseup", () => {
    dragging = false; canvas.style.cursor = "";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const viewAspect = (rect.width || 1) / (rect.height || 1);
    const sx = (texAspect / viewAspect) * zoom;
    const sy = zoom;
    centerX -= (e.clientX - lastX) / rect.width / sx;
    centerY -= (e.clientY - lastY) / rect.height / sy;
    lastX = e.clientX; lastY = e.clientY;
    clampCenter(); render();
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const before = clientToTex(e.clientX, e.clientY);
    zoom = Math.max(0.25, Math.min(20, zoom * Math.exp(-e.deltaY * 0.0015)));
    const after = clientToTex(e.clientX, e.clientY);
    centerX += before.u - after.u;
    centerY += before.v - after.v;
    clampCenter(); render();
  }, { passive: false });

  function clampCenter() {
    centerX = Math.max(0, Math.min(1, centerX));
    centerY = Math.max(0, Math.min(1, centerY));
  }

  function clientToTex(clientX: number, clientY: number): { u: number; v: number } {
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    const viewAspect = (rect.width || 1) / (rect.height || 1);
    const sx = (texAspect / viewAspect) * zoom;
    const sy = zoom;
    return { u: centerX + (px - 0.5) / sx, v: centerY + (py - 0.5) / sy };
  }

  function provinceIdAtClient(clientX: number, clientY: number): number {
    const { u, v } = clientToTex(clientX, clientY);
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return 0;
    return ids[Math.floor(v * texH) * texW + Math.floor(u * texW)];
  }

  function texToClient(u: number, v: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const viewAspect = (rect.width || 1) / (rect.height || 1);
    const sx = (texAspect / viewAspect) * zoom;
    const sy = zoom;
    return {
      x: rect.left + (0.5 + (u - centerX) * sx) * rect.width,
      y: rect.top  + (0.5 + (v - centerY) * sy) * rect.height,
    };
  }

  const viewListeners = new Set<() => void>();
  function onViewChange(cb: () => void): () => void {
    viewListeners.add(cb);
    return () => viewListeners.delete(cb);
  }
  function notifyView() { viewListeners.forEach((cb) => cb()); }

  function setOwnerColors(data: Uint8Array): void {
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, lutW, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
    render();
  }

  function destroy() {
    ro.disconnect();
    if (polyProgram) gl.deleteProgram(polyProgram);
    if (rasterProgram) gl.deleteProgram(rasterProgram);
    gl.deleteProgram(borderProgram);
    if (polyVAO) gl.deleteVertexArray(polyVAO);
    if (rasterVAO) gl.deleteVertexArray(rasterVAO);
    gl.deleteVertexArray(borderQuadVAO);
    if (rasterProvTex) gl.deleteTexture(rasterProvTex);
    if (borderTex) gl.deleteTexture(borderTex);
    gl.deleteTexture(lutTex);
  }

  fit();

  return { setOwnerColors, provinceIdAtClient, texToClient, getZoom: () => zoom, onViewChange, destroy, fit };
}

// ─── GL helpers ──────────────────────────────────────────────────────────────

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load " + url));
    img.crossOrigin = "anonymous";
    img.src = url;
  });
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error("shader compile failed: " + info);
  }
  return s;
}

function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error("program link failed: " + info);
  }
  gl.deleteShader(v);
  gl.deleteShader(f);
  return p;
}
