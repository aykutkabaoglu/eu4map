/**
 * WebGL2 renderer — pdx-tools / nickb.dev style two-pass pipeline.
 *
 *   Stage 1 (map FBO): full-screen quad rendered into an offscreen RGBA8
 *     framebuffer at native province-texture resolution. Each pixel reads
 *     its province ID and the four cardinal neighbours' IDs, looks the
 *     owner colour up in the LUT, and paints country/province borders
 *     onto the dominant-id side so the borders remain exactly one source
 *     texel wide. This pass runs only when the political map changes
 *     (owner colours or initial load).
 *
 *   Stage 2 (xBR): the FBO is sampled by an xBR (level-2, corner-A,
 *     scale 4) pixel-art upscaler verbatim from pdx-tools / nickb.dev.
 *     The 21-tap edge-aware interpolation eliminates the staircase look
 *     of pixel boundaries and produces vector-style edges at any zoom.
 *
 * Province picking still uses the CPU-decoded `ids` array.
 */

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  provincesUrl: string;
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

export async function createRenderer(opts: RendererOptions): Promise<MapRenderer> {
  const { canvas } = opts;
  const glOrNull = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!glOrNull) throw new Error("WebGL2 not supported");
  const gl: WebGL2RenderingContext = glOrNull;

  const img = await loadImage(opts.provincesUrl);
  const texW = img.naturalWidth;
  const texH = img.naturalHeight;

  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (texW > maxTex || texH > maxTex) {
    console.warn(`Province texture (${texW}x${texH}) exceeds GL_MAX_TEXTURE_SIZE (${maxTex}); rendering may fail.`);
  }

  // CPU-side ids for picking.
  const offscreen = document.createElement("canvas");
  offscreen.width = texW; offscreen.height = texH;
  const ctx2d = offscreen.getContext("2d", { willReadFrequently: true })!;
  ctx2d.drawImage(img, 0, 0);
  const imgData = ctx2d.getImageData(0, 0, texW, texH).data;
  const ids = new Uint16Array(texW * texH);
  for (let i = 0, j = 0; i < ids.length; i++, j += 4) {
    ids[i] = (imgData[j] << 8) | imgData[j + 1];
  }

  // ── Province ID texture (RG8 in RGB8 slot, NEAREST) ─────────────────────
  const provTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, provTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // ── Owner LUT ────────────────────────────────────────────────────────────
  const lutW = opts.maxProvinces + 1;
  const lutTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lutW, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(lutW * 4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // ── Stage-1 FBO (texW × texH RGBA8, NEAREST so xBR sees crisp texels) ───
  const mapTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, mapTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, texW, texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const mapFbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, mapFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mapTex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Map FBO incomplete");
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // ── Stage-1 program (simplified map.frag) ───────────────────────────────
  const stage1VS = `#version 300 es
    in vec2 a_pos;
    out vec2 v_texCoord;
    void main() {
      // No Y flip here: the FBO is sampled by stage 2 which flips Y itself,
      // so we want the FBO to mirror the source-image orientation 1:1.
      v_texCoord = (a_pos + 1.0) * 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;
  // Border-on-greater-id side keeps every interface exactly one texel thick.
  // c0.rgb * 0.35 for country borders, * 0.7 for plain province borders.
  const stage1FS = `#version 300 es
    precision mediump float;
    precision highp int;
    uniform sampler2D u_provinces;
    uniform sampler2D u_lut;
    uniform float u_lutW;
    uniform vec2 u_texelSize;
    in vec2 v_texCoord;
    out vec4 outColor;

    int idAt(vec2 tc) {
      vec3 px = texture(u_provinces, tc).rgb;
      return int(px.r * 255.0 + 0.5) * 256 + int(px.g * 255.0 + 0.5);
    }
    vec4 colorOf(int id) {
      float u = (float(id) + 0.5) / u_lutW;
      return texture(u_lut, vec2(u, 0.5));
    }

    void main() {
      vec2 tc = v_texCoord;
      int id0 = idAt(tc);
      int idN = idAt(tc + vec2(0.0, -u_texelSize.y));
      int idS = idAt(tc + vec2(0.0,  u_texelSize.y));
      int idW = idAt(tc + vec2(-u_texelSize.x, 0.0));
      int idE = idAt(tc + vec2( u_texelSize.x, 0.0));

      vec4 c0 = colorOf(id0);
      vec4 cN = colorOf(idN);
      vec4 cS = colorOf(idS);
      vec4 cW = colorOf(idW);
      vec4 cE = colorOf(idE);

      bool provBorder = (id0 < idN) || (id0 < idS) || (id0 < idW) || (id0 < idE);
      bool ctryBorder =
        (id0 < idN && c0 != cN) ||
        (id0 < idS && c0 != cS) ||
        (id0 < idW && c0 != cW) ||
        (id0 < idE && c0 != cE);

      if (ctryBorder)      outColor = vec4(c0.rgb * 0.30, 1.0);
      else if (provBorder) outColor = vec4(c0.rgb * 0.70, 1.0);
      else                 outColor = vec4(c0.rgb, 1.0);
    }
  `;
  const stage1Program = linkProgram(gl, stage1VS, stage1FS);
  const s1_uProv      = gl.getUniformLocation(stage1Program, "u_provinces");
  const s1_uLut       = gl.getUniformLocation(stage1Program, "u_lut");
  const s1_uLutW      = gl.getUniformLocation(stage1Program, "u_lutW");
  const s1_uTexelSize = gl.getUniformLocation(stage1Program, "u_texelSize");

  // ── Stage-2 program (xBR — verbatim from pdx-tools, terrain stripped) ───
  const xbrVS = `#version 300 es
    in vec2 a_pos;
    uniform vec2 u_viewScale;
    uniform vec2 u_viewOffset;
    uniform vec2 u_textureSize;
    out vec2 v_texCoord;
    out vec4 v_t1;
    out vec4 v_t2;
    out vec4 v_t3;
    out vec4 v_t4;
    out vec4 v_t5;
    out vec4 v_t6;
    out vec4 v_t7;
    void main() {
      vec2 uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
      gl_Position = vec4(a_pos * u_viewScale + u_viewOffset, 0.0, 1.0);

      vec2 ps = 1.0 / u_textureSize;
      float dx = ps.x;
      float dy = ps.y;
      v_texCoord = uv;
      // sampling pattern (pdx-tools xbr.vert):
      //    A1 B1 C1
      // A0  A  B  C C4
      // D0  D  E  F F4
      // G0  G  H  I I4
      //    G5 H5 I5
      v_t1 = uv.xxxy + vec4(-dx, 0.0, dx, -2.0*dy);
      v_t2 = uv.xxxy + vec4(-dx, 0.0, dx,     -dy);
      v_t3 = uv.xxxy + vec4(-dx, 0.0, dx,     0.0);
      v_t4 = uv.xxxy + vec4(-dx, 0.0, dx,      dy);
      v_t5 = uv.xxxy + vec4(-dx, 0.0, dx,  2.0*dy);
      v_t6 = uv.xyyy + vec4(-2.0*dx, -dy, 0.0,  dy);
      v_t7 = uv.xyyy + vec4( 2.0*dx, -dy, 0.0,  dy);
    }
  `;
  // xBR fragment shader, copied from pdx-tools/src/map/assets/shaders/xbr.frag
  // with the terrain-composite path removed: image() simply samples the FBO,
  // and the same FBO is used as both the edge-driver and the colour source.
  const xbrFS = `#version 300 es
    #define CORNER_A
    #define XBR_SCALE 4.0
    #define XBR_Y_WEIGHT 48.0
    #define XBR_EQ_THRESHOLD 25.0
    #define XBR_LV2_COEFFICIENT 2.0
    precision mediump float;

    uniform sampler2D u_mapTexture;
    uniform highp vec2 u_textureSize;

    in highp vec4 v_t1;
    in highp vec4 v_t2;
    in highp vec4 v_t3;
    in highp vec4 v_t4;
    in highp vec4 v_t5;
    in highp vec4 v_t6;
    in highp vec4 v_t7;
    in highp vec2 v_texCoord;
    out vec4 outColor;

    const vec4 Ao = vec4( 1.0, -1.0, -1.0, 1.0);
    const vec4 Bo = vec4( 1.0,  1.0, -1.0,-1.0);
    const vec4 Co = vec4( 1.5,  0.5, -0.5, 0.5);
    const vec4 Ax = vec4( 1.0, -1.0, -1.0, 1.0);
    const vec4 Bx = vec4( 0.5,  2.0, -0.5,-2.0);
    const vec4 Cx = vec4( 1.0,  1.0, -0.5, 0.0);
    const vec4 Ay = vec4( 1.0, -1.0, -1.0, 1.0);
    const vec4 By = vec4( 2.0,  0.5, -2.0,-0.5);
    const vec4 Cy = vec4( 2.0,  0.0, -1.0, 0.5);
    const vec4 Ci = vec4(0.25, 0.25, 0.25, 0.25);
    const vec3 Y  = vec3(0.2126, 0.7152, 0.0722);

    vec4 df(vec4 A, vec4 B) { return abs(A - B); }
    float c_df(vec3 c1, vec3 c2) { vec3 d = abs(c1 - c2); return d.r + d.g + d.b; }
    bvec4 eq(vec4 A, vec4 B) { return lessThan(df(A, B), vec4(XBR_EQ_THRESHOLD)); }
    vec4 weighted_distance(vec4 a, vec4 b, vec4 c, vec4 d, vec4 e, vec4 f, vec4 g, vec4 h) {
      return df(a,b) + df(a,c) + df(d,e) + df(d,f) + 4.0 * df(g,h);
    }
    float frac(highp float v) { return v - floor(v); }
    vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }
    bvec4 and_(bvec4 x, bvec4 y) { return bvec4(vec4(x) * vec4(y)); }
    bvec4 or_(bvec4 x, bvec4 y)  { return bvec4(vec4(x) + vec4(y)); }
    vec3 lerp3(vec3 a, vec3 b, float w) { return a + w * (b - a); }
    vec3 lerp3b(vec3 a, vec3 b, bool w) { return a + float(w) * (b - a); }

    vec3 image(highp vec2 tc) { return texture(u_mapTexture, tc).rgb; }

    void main() {
      if (v_texCoord.x < 0.0 || v_texCoord.x > 1.0 || v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
        outColor = vec4(0.05, 0.05, 0.08, 1.0); return;
      }
      bvec4 edri, edr, edr_left, edr_up, px;
      bvec4 interp_restriction_lv0, interp_restriction_lv1, interp_restriction_lv2_left, interp_restriction_lv2_up;
      vec4 fx, fx_left, fx_up;

      vec4 delta  = vec4(1.0/XBR_SCALE);
      vec4 deltaL = vec4(0.5/XBR_SCALE, 1.0/XBR_SCALE, 0.5/XBR_SCALE, 1.0/XBR_SCALE);
      vec4 deltaU = deltaL.yxwz;

      vec2 fp = vec2(frac(v_texCoord.x * u_textureSize.x), frac(v_texCoord.y * u_textureSize.y));

      vec3 A1 = image(v_t1.xw); vec3 B1 = image(v_t1.yw); vec3 C1 = image(v_t1.zw);
      vec3 A  = image(v_t2.xw); vec3 B  = image(v_t2.yw); vec3 C  = image(v_t2.zw);
      vec3 D  = image(v_t3.xw); vec3 E  = image(v_t3.yw); vec3 F  = image(v_t3.zw);
      vec3 G  = image(v_t4.xw); vec3 H  = image(v_t4.yw); vec3 I  = image(v_t4.zw);
      vec3 G5 = image(v_t5.xw); vec3 H5 = image(v_t5.yw); vec3 I5 = image(v_t5.zw);
      vec3 A0 = image(v_t6.xy); vec3 D0 = image(v_t6.xz); vec3 G0 = image(v_t6.xw);
      vec3 C4 = image(v_t7.xy); vec3 F4 = image(v_t7.xz); vec3 I4 = image(v_t7.xw);

      vec4 b = transpose(mat4x3(B, D, H, F)) * (XBR_Y_WEIGHT * Y);
      vec4 c = transpose(mat4x3(C, A, G, I)) * (XBR_Y_WEIGHT * Y);
      vec4 e = transpose(mat4x3(E, E, E, E)) * (XBR_Y_WEIGHT * Y);
      vec4 d = b.yzwx;
      vec4 f = b.wxyz;
      vec4 g = c.zwxy;
      vec4 h = b.zwxy;
      vec4 i = c.wxyz;

      vec4 i4 = transpose(mat4x3(I4, C1, A0, G5)) * (XBR_Y_WEIGHT * Y);
      vec4 i5 = transpose(mat4x3(I5, C4, A1, G0)) * (XBR_Y_WEIGHT * Y);
      vec4 h5 = transpose(mat4x3(H5, F4, B1, D0)) * (XBR_Y_WEIGHT * Y);
      vec4 f4 = h5.yzwx;

      fx      = (Ao * fp.y + Bo * fp.x);
      fx_left = (Ax * fp.y + Bx * fp.x);
      fx_up   = (Ay * fp.y + By * fp.x);

      interp_restriction_lv1 = interp_restriction_lv0 = and_(notEqual(e, f), notEqual(e, h));
      interp_restriction_lv2_left = and_(notEqual(e, g), notEqual(d, g));
      interp_restriction_lv2_up   = and_(notEqual(e, c), notEqual(b, c));

      vec4 fx45i = saturate((fx      + delta  - Co - Ci) / (2.0 * delta));
      vec4 fx45  = saturate((fx      + delta  - Co     ) / (2.0 * delta));
      vec4 fx30  = saturate((fx_left + deltaL - Cx     ) / (2.0 * deltaL));
      vec4 fx60  = saturate((fx_up   + deltaU - Cy     ) / (2.0 * deltaU));

      vec4 wd1 = weighted_distance(e, c, g, i, h5, f4, h, f);
      vec4 wd2 = weighted_distance(h, d, i5, f, i4, b, e, i);

      edri = and_(lessThanEqual(wd1, wd2), interp_restriction_lv0);
      edr  = and_(lessThan(wd1, wd2), interp_restriction_lv1);

      edr      = and_(edr, or_(not(edri.yzwx), not(edri.wxyz)));
      edr_left = and_(and_(and_(lessThanEqual((XBR_LV2_COEFFICIENT * df(f,g)), df(h,c)), interp_restriction_lv2_left), edr), and_(not(edri.yzwx), eq(e, c)));
      edr_up   = and_(and_(and_(greaterThanEqual(df(f,g), (XBR_LV2_COEFFICIENT * df(h,c))), interp_restriction_lv2_up), edr), and_(not(edri.wxyz), eq(e, g)));

      fx45  = vec4(edr) * fx45;
      fx30  = vec4(edr_left) * fx30;
      fx60  = vec4(edr_up)   * fx60;
      fx45i = vec4(edri) * fx45i;

      px = lessThanEqual(df(e, f), df(e, h));

      vec4 maximos = max(max(fx30, fx60), max(fx45, fx45i));

      // We share one FBO between edges and colours.
      A = image(v_t2.xw); B = image(v_t2.yw); C = image(v_t2.zw);
      D = image(v_t3.xw); E = image(v_t3.yw); F = image(v_t3.zw);
      G = image(v_t4.xw); H = image(v_t4.yw); I = image(v_t4.zw);

      vec3 res1 = E;
      res1 = lerp3(res1, lerp3b(H, F, px.x), maximos.x);
      res1 = lerp3(res1, lerp3b(B, D, px.z), maximos.z);

      vec3 res2 = E;
      res2 = lerp3(res2, lerp3b(F, B, px.y), maximos.y);
      res2 = lerp3(res2, lerp3b(D, H, px.w), maximos.w);

      vec3 res = lerp3(res1, res2, step(c_df(E, res1), c_df(E, res2)));
      outColor = vec4(res, 1.0);
    }
  `;
  const xbrProgram   = linkProgram(gl, xbrVS, xbrFS);
  const x_uViewScale  = gl.getUniformLocation(xbrProgram, "u_viewScale");
  const x_uViewOffset = gl.getUniformLocation(xbrProgram, "u_viewOffset");
  const x_uTextureSize = gl.getUniformLocation(xbrProgram, "u_textureSize");
  const x_uMap         = gl.getUniformLocation(xbrProgram, "u_mapTexture");

  // ── Shared full-screen quad ─────────────────────────────────────────────
  const quadBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

  const stage1VAO = gl.createVertexArray()!;
  gl.bindVertexArray(stage1VAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  let aPos1 = gl.getAttribLocation(stage1Program, "a_pos");
  gl.enableVertexAttribArray(aPos1);
  gl.vertexAttribPointer(aPos1, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const xbrVAO = gl.createVertexArray()!;
  gl.bindVertexArray(xbrVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  let aPos2 = gl.getAttribLocation(xbrProgram, "a_pos");
  gl.enableVertexAttribArray(aPos2);
  gl.vertexAttribPointer(aPos2, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // ── Stage-1 render (FBO) ────────────────────────────────────────────────
  function renderStage1() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, mapFbo);
    gl.viewport(0, 0, texW, texH);
    gl.disable(gl.BLEND);
    gl.useProgram(stage1Program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, provTex);
    gl.uniform1i(s1_uProv, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.uniform1i(s1_uLut, 1);
    gl.uniform1f(s1_uLutW, lutW);
    gl.uniform2f(s1_uTexelSize, 1 / texW, 1 / texH);
    gl.bindVertexArray(stage1VAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ── Pan / zoom state ─────────────────────────────────────────────────────
  const texAspect = texW / texH;
  let zoom = 1;
  let centerX = 0.5;
  let centerY = 0.5;

  function computeView() {
    const cw = canvas.clientWidth || 1;
    const ch = canvas.clientHeight || 1;
    const va = cw / ch;
    const sx = (texAspect / va) * zoom;
    const sy = zoom;
    const ox = (0.5 - centerX) * 2 * sx;
    const oy = -(0.5 - centerY) * 2 * sy;
    return { sx, sy, ox, oy };
  }

  function fit() {
    const cw = canvas.clientWidth || 1;
    const ch = canvas.clientHeight || 1;
    const va = cw / ch;
    zoom = texAspect > va ? 1 : Math.min(va / texAspect, 1);
    zoom = Math.min(zoom, 1.0);
    centerX = 0.5; centerY = 0.5;
    render();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor((canvas.clientWidth || 1) * dpr);
    const h = Math.floor((canvas.clientHeight || 1) * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
  }

  // ── Stage-2 render (canvas) ─────────────────────────────────────────────
  function render() {
    resize();
    const { sx, sy, ox, oy } = computeView();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.05, 0.05, 0.08, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    gl.useProgram(xbrProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mapTex);
    gl.uniform1i(x_uMap, 0);
    gl.uniform2f(x_uTextureSize, texW, texH);
    gl.uniform2f(x_uViewScale, sx, sy);
    gl.uniform2f(x_uViewOffset, ox, oy);
    gl.bindVertexArray(xbrVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

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
    const va = (rect.width || 1) / (rect.height || 1);
    const sx = (texAspect / va) * zoom;
    const sy = zoom;
    centerX -= (e.clientX - lastX) / rect.width / sx;
    centerY -= (e.clientY - lastY) / rect.height / sy;
    lastX = e.clientX; lastY = e.clientY;
    clampCenter(); render();
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const before = clientToTex(e.clientX, e.clientY);
    zoom = Math.max(0.25, Math.min(40, zoom * Math.exp(-e.deltaY * 0.0015)));
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
    const va = (rect.width || 1) / (rect.height || 1);
    const sx = (texAspect / va) * zoom;
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
    const va = (rect.width || 1) / (rect.height || 1);
    const sx = (texAspect / va) * zoom;
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
    renderStage1();
    render();
  }

  function destroy() {
    ro.disconnect();
    gl.deleteProgram(stage1Program);
    gl.deleteProgram(xbrProgram);
    gl.deleteVertexArray(stage1VAO);
    gl.deleteVertexArray(xbrVAO);
    gl.deleteBuffer(quadBuf);
    gl.deleteFramebuffer(mapFbo);
    gl.deleteTexture(provTex);
    gl.deleteTexture(lutTex);
    gl.deleteTexture(mapTex);
  }

  fit();

  return { setOwnerColors, provinceIdAtClient, texToClient, getZoom: () => zoom, onViewChange, destroy, fit };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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
