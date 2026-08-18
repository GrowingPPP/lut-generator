// WebGL2 3D LUT 叠加渲染器,支持滑动对比(split)与纯 LUT 两种模式。
const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform sampler3D u_lut;
uniform float u_lutSize;
uniform float u_split;
uniform float u_splitMode;
void main() {
  vec3 c = texture(u_image, v_uv).rgb;
  float s = (u_lutSize - 1.0) / u_lutSize;
  vec3 coord = c * s + 0.5 / u_lutSize;
  vec3 graded = texture(u_lut, coord).rgb;
  vec3 outRgb;
  if (u_splitMode > 0.5) {
    outRgb = v_uv.x < u_split ? c : graded;
  } else {
    outRgb = graded;
  }
  outColor = vec4(outRgb, 1.0);
}
`

export class LUTRenderer {
  constructor(canvas) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
    if (!gl) throw new Error('当前环境不支持 WebGL2')
    this.gl = gl
    gl.getExtension('OES_texture_float_linear')
    this.split = 0.5
    this.splitMode = false
    this.program = this._buildProgram()
    this._setupQuad()
  }

  _compile(type, src) {
    const gl = this.gl
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh))
    }
    return sh
  }

  _buildProgram() {
    const gl = this.gl
    const vs = this._compile(gl.VERTEX_SHADER, VERT)
    const fs = this._compile(gl.FRAGMENT_SHADER, FRAG)
    const prog = gl.createProgram()
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog))
    }
    this.vs = vs
    this.fs = fs
    this.u_image = gl.getUniformLocation(prog, 'u_image')
    this.u_lut = gl.getUniformLocation(prog, 'u_lut')
    this.u_lutSize = gl.getUniformLocation(prog, 'u_lutSize')
    this.u_split = gl.getUniformLocation(prog, 'u_split')
    this.u_splitMode = gl.getUniformLocation(prog, 'u_splitMode')
    return prog
  }

  _setupQuad() {
    const gl = this.gl
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )
    const loc = gl.getAttribLocation(this.program, 'a_pos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    this.buffer = buf
    this.vao = vao
  }

  setImage(source) {
    const gl = this.gl
    this.canvas.width = source.width
    this.canvas.height = source.height
    if (this.imageTex) {
      gl.deleteTexture(this.imageTex)
      this.imageTex = null
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.imageTex = tex
  }

  setLUT(data, size) {
    const gl = this.gl
    if (this.lutTex) {
      gl.deleteTexture(this.lutTex)
      this.lutTex = null
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, size, size, size, 0, gl.RGBA, gl.FLOAT, data)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    this.lutTex = tex
    this.lutSize = size
  }

  setSplit(x) {
    this.split = x
  }

  setSplitMode(mode) {
    this.splitMode = mode
  }

  // 释放全部 GL 资源。不 loseContext,以便 canvas 被复用(StrictMode 双跑/切展示形式)。
  dispose() {
    const gl = this.gl
    if (this.imageTex) { gl.deleteTexture(this.imageTex); this.imageTex = null }
    if (this.lutTex) { gl.deleteTexture(this.lutTex); this.lutTex = null }
    if (this.buffer) { gl.deleteBuffer(this.buffer); this.buffer = null }
    if (this.vao) { gl.deleteVertexArray(this.vao); this.vao = null }
    if (this.vs) { gl.deleteShader(this.vs); this.vs = null }
    if (this.fs) { gl.deleteShader(this.fs); this.fs = null }
    if (this.program) { gl.deleteProgram(this.program); this.program = null }
  }

  render() {
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex)
    gl.uniform1i(this.u_image, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex)
    gl.uniform1i(this.u_lut, 1)
    gl.uniform1f(this.u_lutSize, this.lutSize)
    gl.uniform1f(this.u_split, this.split)
    gl.uniform1f(this.u_splitMode, this.splitMode ? 1 : 0)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }
}
