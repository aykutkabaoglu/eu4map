/**
 * WebGL2 renderer for the EU4 map.
 *
 * Inputs:
 *   - provinces_id.png (RGB8, 5632×2048): R = id>>8, G = id&0xFF
 *   - owner color LUT (RGBA8, (max+1)×1): one color per province id
 *
 * Pan via drag, zoom via wheel. Province id at screen pixel is resolved from
 * the CPU-side ids TypedArray (decoded once from the PNG) so we don't need
 * gl.readPixels per hover.
 */

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  provincesUrl: string; // e.g. "/data/provinces_id.png"
  bordersUrl?: string;  // e.g. "/data/province_borders.png" (optional)
  maxProvinces: number;
}

export interface MapRenderer {
  setOwnerColors(data: Uint8Array): void;
  provinceIdAtClient(clientX: number, clientY: number): number;
  /** Convert texture coords (u,v in 0..1) to client pixel coords. */
  texToClient(u: number, v: number): { x: number; y: number };
  /** Current zoom level (1 = fit-to-width). Used to scale overlay labels. */
  getZoom(): number;
  /** Register a callback that fires whenever the view (pan/zoom) changes. */
  onViewChange(cb: () => void): () => void;
  destroy(): void;
  fit(): void;
}

export async function createRenderer(opts: RendererOptions): Promise<MapRenderer> {
  const { canvas } = opts;
  const glOrNull = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!glOrNull) throw new Error("WebGL2 not supported");
  const gl: WebGL2RenderingContext = glOrNull;

  // ----- load provinces texture
  const img = await loadImage(opts.provincesUrl);
  const texW = img.naturalWidth;
  const texH = img.naturalHeight;

  // Decode ids once on CPU for pick operations.
  const offscreen = document.createElement("canvas");
  offscreen.width = texW;
  offscreen.height = texH;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, texW, texH).data;
  const ids = new Uint16Array(texW * texH);
  for (let i = 0, j = 0; i < ids.length; i++, j += 4) {
    ids[i] = (imgData[j] << 8) | imgData[j + 1];
  }

  const provinceTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, provinceTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // ----- border mask texture (optional; faint dark lines between provinces)
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

  // ----- owner color LUT (1D-like 2D texture, width = max+1, height = 1)
  const lutW = opts.maxProvinces + 1;
  const lutTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA8, lutW, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array(lutW * 4),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // ----- shaders
  const vsSrc = `#version 300 es
    in vec2 a_pos;       // clip-space vertex (-1..1 quad)
    out vec2 v_uv;
    uniform vec2 u_viewScale;   // scaling of the quad in clip space
    uniform vec2 u_viewOffset;  // translation in clip space
    void main() {
      v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
      vec2 p = a_pos * u_viewScale + u_viewOffset;
      gl_Position = vec4(p, 0.0, 1.0);
    }
  `;
  const fsSrc = `#version 300 es
    precision highp float;
    precision highp int;
    in vec2 v_uv;
    uniform sampler2D u_provinces;
    uniform sampler2D u_lut;
    uniform sampler2D u_borders;
    uniform float u_lutWidth;
    uniform float u_hasBorder;
    uniform vec2 u_texelSize;   // 1/texW, 1/texH
    out vec4 outColor;

    vec4 lutColor(vec2 uv) {
      vec4 px = texture(u_provinces, uv);
      int id = int(px.r * 255.0 + 0.5) * 256 + int(px.g * 255.0 + 0.5);
      float u = (float(id) + 0.5) / u_lutWidth;
      return texture(u_lut, vec2(u, 0.5));
    }

    void main() {
      if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
        outColor = vec4(0.05, 0.05, 0.08, 1.0);
        return;
      }
      // Single NEAREST fetch — crisp province fill. Edges are drawn by the
      // border mask below, so in-province aliasing is invisible.
      vec4 base = lutColor(v_uv);

      if (u_hasBorder > 0.5) {
        // LINEAR-filtered mask: 1-px borders anti-alias with zoom.
        float b1 = texture(u_borders, v_uv).r;
        float b2 = texture(u_borders, v_uv + vec2(u_texelSize.x, 0.0)).r;
        float b3 = texture(u_borders, v_uv + vec2(0.0, u_texelSize.y)).r;
        float b4 = texture(u_borders, v_uv + u_texelSize).r;
        float border = 0.25 * (b1 + b2 + b3 + b4);
        // Darken toward 55% at full mask, weighted 0.7 — faint but visible.
        base.rgb = mix(base.rgb, base.rgb * 0.55, border * 0.7);
      }
      outColor = base;
    }
  `;

  const program = linkProgram(gl, vsSrc, fsSrc);
  const uProv = gl.getUniformLocation(program, "u_provinces");
  const uLut = gl.getUniformLocation(program, "u_lut");
  const uBord = gl.getUniformLocation(program, "u_borders");
  const uHasBord = gl.getUniformLocation(program, "u_hasBorder");
  const uLutW = gl.getUniformLocation(program, "u_lutWidth");
  const uTexelSize = gl.getUniformLocation(program, "u_texelSize");
  const uViewScale = gl.getUniformLocation(program, "u_viewScale");
  const uViewOffset = gl.getUniformLocation(program, "u_viewOffset");
  const aPos = gl.getAttribLocation(program, "a_pos");

  // fullscreen quad
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // ----- pan / zoom state
  // Coordinate convention:
  //   map covers texture u in [0,1], v in [0,1]
  //   viewScale = how much clip-space area the quad occupies
  //   viewOffset = where the quad center is in clip-space
  // To pan we move offset; to zoom we change scale. We compute from
  //   zoom (tex pixels per screen pixel), centerX/centerY (tex coords at screen center).
  let zoom = 1;
  let centerX = 0.5;
  let centerY = 0.5;

  function fit(): void {
    const canvasW = canvas.clientWidth || 1;
    const canvasH = canvas.clientHeight || 1;
    const texAspect = texW / texH;
    const viewAspect = canvasW / canvasH;
    // fit to width
    zoom = Math.min(viewAspect / texAspect, 1);
    if (texAspect > viewAspect) {
      zoom = 1; // fit to width
    } else {
      zoom = viewAspect / texAspect;
    }
    zoom = Math.min(zoom, 1.0);
    centerX = 0.5;
    centerY = 0.5;
    render();
  }

  function updateView() {
    const canvasW = canvas.clientWidth || 1;
    const canvasH = canvas.clientHeight || 1;
    const texAspect = texW / texH;
    const viewAspect = canvasW / canvasH;

    // Scale of quad in clip-space so that the visible portion = 1/zoom of texture.
    // When zoom = 1 and viewAspect == texAspect, quad covers [-1,1]^2.
    const sx = (texAspect / viewAspect) * zoom;
    const sy = 1 * zoom;

    // Offset so that (centerX, centerY) in texture lands at screen center.
    // tex u ranges over [centerX - 0.5/zoom*, centerX + 0.5/zoom*]. Mapping u->x:
    // x = (u - centerX) * 2 * (sx / something). Concretely: offset shifts the quad.
    const ox = (0.5 - centerX) * 2 * sx;
    const oy = -(0.5 - centerY) * 2 * sy;

    gl.uniform2f(uViewScale, sx, sy);
    gl.uniform2f(uViewOffset, ox, oy);
  }

  function resize() {
    const dpr = (window.devicePixelRatio || 1) * 3;
    const w = Math.floor((canvas.clientWidth || 1) * dpr);
    const h = Math.floor((canvas.clientHeight || 1) * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function render() {
    resize();
    gl.clearColor(0.05, 0.05, 0.08, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, provinceTex);
    gl.uniform1i(uProv, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.uniform1i(uLut, 1);
    gl.uniform1f(uLutW, lutW);
    gl.uniform2f(uTexelSize, 1 / texW, 1 / texH);
    gl.uniform1f(uHasBord, hasBorder ? 1.0 : 0.0);
    if (hasBorder) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, borderTex);
      gl.uniform1i(uBord, 2);
    }
    updateView();
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    notifyView();
  }

  // ----- mouse interactions
  const ro = new ResizeObserver(() => render());
  ro.observe(canvas);

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.style.cursor = "grabbing";
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    canvas.style.cursor = "";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const texAspect = texW / texH;
    const viewAspect = (rect.width || 1) / (rect.height || 1);
    const sx = (texAspect / viewAspect) * zoom;
    const sy = zoom;
    const dx = (e.clientX - lastX) / rect.width;
    const dy = (e.clientY - lastY) / rect.height;
    lastX = e.clientX;
    lastY = e.clientY;
    // screen -> tex: one screen width = 2/sx texture widths? invert.
    centerX -= dx / sx;
    centerY -= dy / sy;
    clampCenter();
    render();
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    // tex coord under mouse before zoom
    const before = clientToTex(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoom = Math.max(0.25, Math.min(20, zoom * factor));
    // keep the same tex coord under the mouse: adjust center
    const after = clientToTex(e.clientX, e.clientY);
    centerX += before.u - after.u;
    centerY += before.v - after.v;
    clampCenter();
    render();
  }, { passive: false });

  function clampCenter() {
    // Prevent panning too far off the map. Allow some overshoot when zoomed out.
    centerX = Math.max(0, Math.min(1, centerX));
    centerY = Math.max(0, Math.min(1, centerY));
  }

  function clientToTex(clientX: number, clientY: number): { u: number; v: number } {
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width;   // 0..1
    const py = (clientY - rect.top) / rect.height;   // 0..1
    const texAspect = texW / texH;
    const viewAspect = (rect.width || 1) / (rect.height || 1);
    const sx = (texAspect / viewAspect) * zoom;
    const sy = zoom;
    const u = centerX + (px - 0.5) / sx;
    const v = centerY + (py - 0.5) / sy;
    return { u, v };
  }

  function provinceIdAtClient(clientX: number, clientY: number): number {
    const { u, v } = clientToTex(clientX, clientY);
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return 0;
    const x = Math.floor(u * texW);
    const y = Math.floor(v * texH);
    return ids[y * texW + x];
  }

  function texToClient(u: number, v: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const texAspect = texW / texH;
    const viewAspect = (rect.width || 1) / (rect.height || 1);
    const sx = (texAspect / viewAspect) * zoom;
    const sy = zoom;
    const px = 0.5 + (u - centerX) * sx;
    const py = 0.5 + (v - centerY) * sy;
    return { x: rect.left + px * rect.width, y: rect.top + py * rect.height };
  }

  const viewListeners = new Set<() => void>();
  function onViewChange(cb: () => void): () => void {
    viewListeners.add(cb);
    return () => viewListeners.delete(cb);
  }
  function notifyView() {
    viewListeners.forEach((cb) => cb());
  }

  function setOwnerColors(data: Uint8Array): void {
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, lutW, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, data,
    );
    render();
  }

  function destroy() {
    ro.disconnect();
    gl.deleteProgram(program);
    gl.deleteBuffer(vbo);
    gl.deleteVertexArray(vao);
    gl.deleteTexture(provinceTex);
    gl.deleteTexture(lutTex);
    if (borderTex) gl.deleteTexture(borderTex);
  }

  fit();

  return {
    setOwnerColors,
    provinceIdAtClient,
    texToClient,
    getZoom: () => zoom,
    onViewChange,
    destroy,
    fit,
  };
}

// ---------- gl helpers ----------

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
