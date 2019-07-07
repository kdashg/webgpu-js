if (window.GPUBufferUsage === undefined) {
   GPUBufferUsage = {
      NONE         : 0x0000,
      MAP_READ     : 0x0001,
      MAP_WRITE    : 0x0002,
      TRANSFER_SRC : 0x0004,
      TRANSFER_DST : 0x0008,
      INDEX        : 0x0010,
      VERTEX       : 0x0020,
      UNIFORM      : 0x0040,
      STORAGE      : 0x0080,
   };
}
if (window.GPUTextureUsage === undefined) {
   GPUTextureUsage = {
      NONE              : 0x00,
      TRANSFER_SRC      : 0x01,
      TRANSFER_DST      : 0x02,
      SAMPLED           : 0x04,
      STORAGE           : 0x08,
      OUTPUT_ATTACHMENT : 0x10,
   };
}
if (window.GPUShaderStageBit === undefined) {
   GPUShaderStageBit = {
      NONE     : 0x0,
      VERTEX   : 0x1,
      FRAGMENT : 0x2,
      COMPUTE  : 0x4,
   };
}
if (window.GPUColorWriteBits === undefined) {
   GPUColorWriteBits = {
      NONE  : 0x0,
      RED   : 0x1,
      GREEN : 0x2,
      BLUE  : 0x4,
      ALPHA : 0x8,
      ALL   : 0xF,
   };
}

navigator.gpu_js = (() => {
   const GL = WebGL2RenderingContext;
   const ORIG_GET_CONTEXT = HTMLCanvasElement.prototype.getContext;
   const SYNC_ERROR_DISPATCH = true;

   function is_subset(a, b) {
      for (const k in b) {
         let v_a = a[k];
         let v_b = b[k];
         if (typeof v_a === 'boolean') {
            v_a = v_a ? 1 : 0;
            v_b = v_b ? 1 : 0;
         }
         if (v_a > v_b)
            return false;
      }
      return true;
   }

   function lose_gl(gl) {
      const e = gl.getExtension('WEBGL_lose_context');
      if (e) {
         e.loseContext();
      }
   }

   class GlInfo {
      constructor(gl) {
         let renderer_pname = gl.RENDERER;
         const ext = gl.getExtension('WEBGL_debug_renderer_info');
         if (ext) {
            renderer_pname = ext.UNMASKED_RENDERER_WEBGL;
         }

         this.name = 'WebGPU.js on ' + gl.getParameter(renderer_pname);

         this.extensions = {
            anisotropicFiltering: false,
         };
         const gl_exts = gl.getSupportedExtensions();
         if (gl_exts.includes('EXT_texture_filter_anisotropic')) {
            this.extensions.anisotropicFiltering = true;
         }

         this.limits = {
            maxBindGroups: 4,
         };
      }
   }

   // -

   const setZeroTimeout = (function() {
     // See https://dbaron.org/log/20100309-faster-timeouts

     var timeouts = [];
     var messageName = "zero-timeout-message";

     // Like setTimeout, but only takes a function argument.  There's
     // no time argument (always zero) and no arguments (you have to
     // use a closure).
     function setZeroTimeout(fn) {
         timeouts.push(fn);
         window.postMessage(messageName, "*");
     }

     function handleMessage(event) {
         if (event.source == window && event.data == messageName) {
             event.stopPropagation();
             if (timeouts.length > 0) {
                 var fn = timeouts.shift();
                 fn();
             }
         }
     }

     window.addEventListener("message", handleMessage, true);

     return setZeroTimeout;
   })();

   // -

   function ASSERT(val, info) {
      if (!val) throw new Error('ASSERT: ' + info);
   }

   // -

   const IS_GPU_ERROR = {};

   if (window.GPUOutOfMemoryError === undefined) {
      window.GPUOutOfMemoryError = class GPUOutOfMemoryError extends Error {
         constructor() {
            super('<GPUOutOfMemoryError>');
            this.name = 'GPUOutOfMemoryError';
         }
      };
      IS_GPU_ERROR['GPUOutOfMemoryError'] = true;
   }
   if (window.GPUValidationError === undefined) {
      window.GPUValidationError = class GPUValidationError extends Error {
         constructor(message) {
            ASSERT(message, '`GPUValidationError.constructor` requires `message`.');
            super(message);
            this.name = 'GPUValidationError';
         }
      };
      IS_GPU_ERROR['GPUValidationError'] = true;
   }

   // -

   function REQUIRE_NON_NULL(desc, name) {
      if (!desc) console.error(new TypeError(name + ' shall not be null.'));
      if (!desc) throw new TypeError(name + ' shall not be null.');
   }

   function REQUIRE(dict, type, key, val_type, fn_map) {
      const name = '`' + type + '.' + key + '`';
      if (dict[key] === undefined) throw new ReferenceError(name + ' required.');
      if (val_type) {
         if (!(dict[key] instanceof val_type)) {
            //console.log('val_type', val_type);
            throw new TypeError(name + ' must be `' + val_type.name + '`.');
         }
      }
      if (fn_map) {
         dict[key] = fn_map(dict[key]);
      }
   }

   function REQUIRE_SEQ(dict, type, key, val_type, fn_map) {
      const name = '`' + type + '.' + key + '`';
      if (dict[key] === undefined) throw new ReferenceError(name + ' required.');
      if (dict[key].length === undefined) throw new TypeError(name + ' must be a sequence.');
      const seq = dict[key];
      for (const i in seq) {
         const name_i = type + '.' + key + '[' + i + ']';
         if (val_type) {
            if (!(seq[i] instanceof val_type)) {
               //console.log('val_type', val_type);
               throw new TypeError(name + ' must be `' + val_type.name + '`.');
            }
         }
         if (fn_map) {
            seq[i] = fn_map(seq[i]);
         }
      }
   }

   function REQUIRE_VAL(dict, type, key, val) {
      const name = '`' + type + '.' + key + '`';
      if (dict[key] !== val) throw new Error(name + ' must be ' + val);
   }

   function VALIDATE(ok, message) {
      if (!ok) throw new GPUValidationError(message);
   }

   // -

   function make_GPUColor(dict) {
      if (dict.length) {
         if (dict.length != 4) throw new TypeError('`GPUColor.length` must be 4.');
         dict = {
            r: dict[0],
            g: dict[1],
            b: dict[2],
            a: dict[3],
         };
      } else {
         REQUIRE(dict, 'GPUColor', 'r');
         REQUIRE(dict, 'GPUColor', 'g');
         REQUIRE(dict, 'GPUColor', 'b');
         REQUIRE(dict, 'GPUColor', 'a');
         dict = Object.assign({}, dict);
      }
      return dict;
   }

   function make_GPUOrigin2D(dict) {
      dict = Object.assign({
         x: dict[0] || 0,
         y: dict[1] || 0,
      }, dict);
      Object.defineProperties(dict, {
         width: {
            get: () => { throw new ReferenceError('No `GPUOrigin2D.width`. Did you mean `x`?'); },
         },
         height: {
            get: () => { throw new ReferenceError('No `GPUOrigin2D.height`. Did you mean `y`?'); },
         },
         depth: {
            get: () => { throw new ReferenceError('No `GPUOrigin2D.depth`.'); },
         },
      });
      return dict;
   }

   function make_GPUOrigin3D(dict) {
      dict = Object.assign({
         x: dict[0] || 0,
         y: dict[1] || 0,
         z: dict[2] || 0,
      }, dict);
      Object.defineProperties(dict, {
         width: {
            get: () => { throw new ReferenceError('No `GPUOrigin3D.width`. Did you mean `x`?'); },
         },
         height: {
            get: () => { throw new ReferenceError('No `GPUOrigin3D.height`. Did you mean `y`?'); },
         },
         depth: {
            get: () => { throw new ReferenceError('No `GPUOrigin3D.depth`. Did you mean `z`?'); },
         },
      });
      return dict;
   }

   function make_GPUExtent3D(dict) {
      if (dict.length) {
         if (dict.length != 3) throw new TypeError('`GPUExtent3D.length` must be 3.');
         dict = {
            width: dict[0],
            height: dict[1],
            depth: dict[2],
         };
      } else {
         dict = Object.assign({}, dict);
         REQUIRE(dict, 'GPUExtent3D', 'width');
         REQUIRE(dict, 'GPUExtent3D', 'height');
         REQUIRE(dict, 'GPUExtent3D', 'depth');
      }
      Object.defineProperties(dict, {
         x: {
            get: () => { throw new ReferenceError('No `GPUExtent3D.x`. Did you mean `width`?'); },
         },
         y: {
            get: () => { throw new ReferenceError('No `GPUExtent3D.y`. Did you mean `height`?'); },
         },
         z: {
            get: () => { throw new ReferenceError('No `GPUExtent3D.z`. Did you mean `depth`?'); },
         },
      });
      return dict;
   }

   // -----------------

   /*
   STREAM_: Specified once, used at most a few times.
   STATIC_: Specified once, used many times.
   DYNAMIC_: Respecified repeatedly, used many times.
   _DRAW: Specified by app, used as source for GL.
   _READ: Specified by reading from GL, queried by app.
   _COPY: Specified by reading from GL, used as source for GL.
   */
   function infer_gl_buf_usage(gpu_usage_bits, will_start_mapped) {
      // Cheeky string-manip keys!
      if (gpu_usage_bits & GPUBufferUsage.MAP_WRITE)
         return GL.DYNAMIC_DRAW;

      if (gpu_usage_bits & GPUBufferUsage.MAP_READ) {
         if (gpu_usage_bits & GPUBufferUsage.STORAGE)
            return GL.DYNAMIC_READ;
         return GL.STREAM_READ;
      }

      const for_draw_bits = (GPUBufferUsage.INDEX |
                             GPUBufferUsage.VERTEX |
                             GPUBufferUsage.UNIFORM |
                             GPUBufferUsage.INDIRECT);
      const is_for_draw = (gpu_usage_bits & for_draw_bits);
      if (will_start_mapped) {
         if (is_for_draw)
            return GL.STATIC_DRAW;
         return GL.STREAM_DRAW;
      }

      if (gpu_usage_bits & GPUBufferUsage.STORAGE)
         return GL.DYNAMIC_COPY;
      if (is_for_draw)
         return GL.STATIC_COPY;
      return GL.STREAM_COPY;
   }

   class GPUBuffer_JS {
      constructor(device, desc, will_start_mapped) {
         this.device = device;
         if (!desc)
            return;
         desc = make_GPUBufferDescriptor(desc);

         this.desc = desc;
         this._gl_usage = infer_gl_buf_usage(desc.usage, will_start_mapped);

         if (desc.usage & (GPUBufferUsage.MAP_READ | GPUBufferUsage.MAP_WRITE)) {
            this._map_buf = new Uint8Array(desc.size);
         }

         this._gl_target = GL.ARRAY_BUFFER;
         if (desc.usage & GPUBufferUsage.INDEX) {
            ASSERT(!(desc.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.UNIFORM)),
                   'Not supported: GPUBufferUsage.INDEX combined with VERTEX and UNIFORM');
            this._gl_target = GL.ELEMENT_ARRAY_BUFFER;
         }

         if (!will_start_mapped) {
            const gl = this.device.gl;
            this.buf = gl.createBuffer();
            gl.bindBuffer(this._gl_target, this.buf);

            ASSERT(!gl.getError(), 'Should be no GL error.');
            gl.bufferData(this._gl_target, desc.size, this._gl_usage);
            if (gl.getError() == GL.OUT_OF_MEMORY)
               throw new GPUOutOfMemoryError();

            gl.bindBuffer(this._gl_target, null);
         }
      }

      _map_write() {
         if (this._map_buf) {
            this._write_map = this._map_buf;
         }
         if (!this._write_map) {
            // Create temporary for initial upload.
            this._write_map = new Uint8Array(this.desc.size);
         }
         this._map_ready = true;
         return this._write_map.buffer;
      }

      _mapped() {
         return this._read_map || this._write_map;
      }

      mapWriteAsync() {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(!this._mapped(), 'Cannot be mapped.');
            VALIDATE(this.desc.usage & GPUBufferUsage.MAP_WRITE, 'Missing GPUBufferUsage.MAP_WRITE.');

            const ret = this._map_write();
            return new Promise((good, bad) => {
               ASSERT(this._mapped() && this._map_ready, '(should be ready)');
               good(ret);
            });
         } catch (e) { this.device._catch(e); }
      }

      mapReadAsync() {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(!this._mapped(), 'Cannot be mapped.');
            VALIDATE(this.desc.usage & GPUBufferUsage.MAP_READ, 'Missing GPUBufferUsage.MAP_READ.');
            this._read_map = this._map_buf;

            let p_good; // :p
            const p = new Promise((good, bad) => {
               p_good = good;
            });

            this.device._add_fenced_todo(() => {
               const gl = this.device.gl;
               gl.bindBuffer(this._gl_target, this.buf);
               gl.getBufferSubData(this._gl_target, 0, this._read_map);
               gl.bindBuffer(this._gl_target, null);

               this._map_ready = true;
               ASSERT(this._mapped() && this._map_ready, '(should be ready)');
               p_good(this._read_map.buffer);
            });
            return p;
         } catch (e) { this.device._catch(e); }
      }

      unmap() {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(this._map_ready, 'unmap() target must be presently mapped.');

            if (this._read_map) {
               this._read_map = null;
               return;
            }

            const gl = this.device.gl;
            if (!this.buf) {
               this.buf = gl.createBuffer();
               gl.bindBuffer(this._gl_target, this.buf);

               ASSERT(!gl.getError(), 'Should be no GL error.');
               gl.bufferData(this._gl_target, this._write_map, this._gl_usage);
               if (gl.getError() == GL.OUT_OF_MEMORY)
                  throw new GPUOutOfMemoryError();

               gl.bindBuffer(this._gl_target, null);
            } else {
               gl.bindBuffer(this._gl_target, this.buf);
               gl.bufferSubData(this._gl_target, 0, this._write_map);
               gl.bindBuffer(this._gl_target, null);
            }
            this._write_map = null;
         } catch (e) { this.device._catch(e); }
      }

      destroy() {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(!this._mapped(), 'Cannot be mapped.');
            if (this.buf) {
               const gl = this.device.gl;
               gl.deleteBuffer(this.buf);
            }
            this._map_buf = null;
         } catch (e) { this.device._catch(e); }
      }
   }

   function make_GPUBufferDescriptor(desc) {
      desc = Object.assign({
      }, desc);
      REQUIRE(desc, 'GPUBufferDescriptor', 'size');
      REQUIRE(desc, 'GPUBufferDescriptor', 'usage');
      return desc;
   }


   // -----------------

   function make_GPUTextureViewDescriptor(desc) {
      desc = Object.assign({
         baseMipLevel: 0,
         mipLevelCount: 1,
         baseArrayLayer: 0,
         arrayLayerCount: 1,
      }, desc);
      REQUIRE(desc, 'GPUTextureViewDescriptor', 'format');
      REQUIRE(desc, 'GPUTextureViewDescriptor', 'dimension');
      REQUIRE(desc, 'GPUTextureViewDescriptor', 'aspect');
      return desc;
   }

   class GPUTextureView_JS {
      constructor(tex, desc) {
         this.tex = tex;
         this.desc = desc;
      }
   }

   // -

   function make_GPUTextureDescriptor(desc) {
      desc = Object.assign({
         arrayLayerCount: 1,
         mipLevelCount: 1,
         sampleCount: 1,
         dimension: '2d',
      }, desc);
      REQUIRE(desc, 'GPUTextureDescriptor', 'size');
      REQUIRE(desc, 'GPUTextureDescriptor', 'format');
      REQUIRE(desc, 'GPUTextureDescriptor', 'usage');
      desc.size = make_GPUExtent3D(desc.size);
      return desc;
   }

   const GL_TEX_FORMAT = {
      /* Normal 8 bit formats */
      r8unorm: GL.R8,
      //r8unorm-srgb: GL.SRGB8_ALPHA8,
      r8snorm: GL.R8_SNORM,
      r8uint: GL.R8UI,
      r8sint: GL.R8I,

      /* Normal 16 bit formats */
      //r16unorm: GL.R16,
      //r16snorm: GL.R16_SNORM,
      r16uint: GL.R16UI,
      r16sint: GL.R16I,
      r16float: GL.R16F,
      rg8unorm: GL.RG8,
      //rg8unorm-srgb: GL.SRGB8_ALPHA8,
      rg8snorm: GL.RG8_SNORM,
      rg8uint: GL.RG8UI,
      rg8sint: GL.RG8I,

      /* Packed 16 bit formats */
      b5g6r5unorm: GL.RGB565,

      /* Normal 32 bit formats */
      r32uint: GL.R32UI,
      r32sint: GL.R32I,
      r32float: GL.R32F,
      //rg16unorm: GL.RG16,
      //rg16snorm: GL.RG16_SNORM,
      rg16uint: GL.RG16UI,
      rg16sint: GL.RG16I,
      rg16float: GL.RG16F,
      rgba8unorm: GL.RGBA8,
      'rgba8unorm-srgb': GL.SRGB8_ALPHA8,
      rgba8snorm: GL.RGBA8_SNORM,
      rgba8uint: GL.RGBA8UI,
      rgba8sint: GL.RGBA8I,
      bgra8unorm: GL.RGBA8,
      'bgra8unorm-srgb': GL.SRGB8_ALPHA8,

      /* Packed 32 bit formats */
      rgb10a2unorm: GL.RGB10_A2,
      rg11b10float: GL.R11F_G11F_B10F,

      /* Normal 64 bit formats */
      rg32uint: GL.RG32UI,
      rg32sint: GL.RG32I,
      rg32float: GL.RG32F,
      //rgba16unorm: GL.RGBA16,
      //rgba16snorm: GL.RGBA16_SNORM,
      rgba16uint: GL.RGBA16UI,
      rgba16sint: GL.RGBA16I,
      rgba16float: GL.RGBA16F,

      /* Normal 128 bit formats */
      rgba32uint: GL.RGBA32UI,
      rgba32sint: GL.RGBA32I,
      rgba32float: GL.RGBA32F,

      depth32float: GL.DEPTH_COMPONENT32F,
      depth24plus: GL.DEPTH_COMPONENT24,
      'depth24plus-stencil8': GL.DEPTH24_STENCIL8,
   };

   class GPUTexture_JS {
      constructor(device, desc, swap_chain) {
         this.device = device;
         if (!desc)
            return;
         desc = make_GPUTextureDescriptor(desc);
         this.desc = desc;
         this.swap_chain = swap_chain;

         if (!this.swap_chain) {
            this._ensure_tex();
         }
      }

      _ensure_tex() {
         if (!this.tex) {
            const gl = dev.gl;
            if (desc.sampleCount != 1) throw new Error('desc.sampleCount >1 not supported.');

            const tex = gl.createTexture();
            this.tex = tex;
            tex.format = GL_TEX_FORMAT[desc.format];

            function bind(target) {
               tex.target = target;
               gl.bindTexture(target, tex);
            }

            if (desc.dimension == '1d') {
               desc.size.height = 1;
               desc.size.depth = 1;
            } else if (desc.dimension == '2d') {
               desc.size.depth = 1;
            }

            if (desc.dimension == '3d') {
               bind(GL.TEXTURE_3D);
               gl.texStorage3D(tex.target, desc.mipLevelCount, tex.format, desc.size.width,
                               desc.size.height, desc.size.depth);
            } else if (desc.arrayLayerCount == 6 &&
                desc.usage & GPUTextureUsage.SAMPLED) {
               bind(GL.TEXTURE_CUBE_MAP); //  A Good Guess. :)
               gl.texStorage2D(tex.target, desc.mipLevelCount, tex.format, desc.size.width,
                               desc.size.height);
            } else if (desc.arrayLayerCount > 1) {
               tex.target = GL.TEXTURE_2D_ARRAY;
               gl.texStorage3D(tex.target, desc.mipLevelCount, tex.format, desc.size.width,
                               desc.size.height, desc.arrayLayerCount);
            } else {
               tex.target = GL.TEXTURE_2D;
               if (desc.dimension == '1d') {
                  desc.size.height = 1;
               }
               gl.texStorage2D(tex.target, desc.mipLevelCount, tex.format, desc.size.width,
                               desc.size.height);
            }
         }
         return this.tex;
      }

      createView(desc) {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            return new GPUTextureView_JS(this, make_GPUTextureViewDescriptor(desc));
         } catch (e) { this.device._catch(e); }
      }

      createDefaultView() {
         try {
            return this.createView({
               format: this.desc.format,
               dimension: this.desc.dimension,
               aspect: 'all',
            });
         } catch (e) { this.device._catch(e); }
      }

      destroy() {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            const gl = this.device.gl;
            gl.deleteTexture(this.tex);
         } catch (e) { this.device._catch(e); }
      }
   }

   // -

   class GPUBindGroupLayout_JS {
      constructor(device, desc) {
         this.device = device;
         if (!desc)
            return;
         desc = make_GPUBindGroupLayout(desc);
         this.desc = desc;
      }
   }

   function make_GPUBindGroupLayout(desc) {
      desc = Object.assign({
      }, desc);
      REQUIRE_SEQ(desc, 'GPUBindGroupLayoutDescriptor', 'bindings', null, make_GPUBindGroupLayoutBinding);
      return desc;
   }
   function make_GPUBindGroupLayoutBinding(desc) {
      desc = Object.assign({
         dynamic: false,
      }, desc);
      REQUIRE(desc, 'GPUBindGroupLayoutBinding', 'binding');
      REQUIRE(desc, 'GPUBindGroupLayoutBinding', 'visibility');
      REQUIRE(desc, 'GPUBindGroupLayoutBinding', 'type');
      return desc;
   }

   // -

   class GPUPipelineLayout_JS {
      constructor(device, desc) {
         this.device = device;
         if (!desc)
            return;
         desc = make_GPUPipelineLayoutDescriptor(desc);
         this.desc = desc;
      }
   }

   function make_GPUPipelineLayoutDescriptor(desc) {
      desc = Object.assign({
      }, desc);
      REQUIRE_SEQ(desc, 'GPUPipelineLayoutDescriptor', 'bindGroupLayouts', GPUBindGroupLayout_JS);
      return desc;
   }

   // -

   const PRIM_TOPO = {
      'point-list'    : GL.POINTS,
      'line-list'     : GL.LINES,
      'line-strip'    : GL.LINE_STRIP,
      'triangle-list' : GL.TRIANGLES,
      'triangle-strip': GL.TRIANGLE_STRIP,
   };

   const VERTEX_FORMAT = {
      uchar2     : {channels: 2, size: 1*2, type: GL.UNSIGNED_BYTE , norm: false, float: false},
      uchar4     : {channels: 4, size: 1*4, type: GL.UNSIGNED_BYTE , norm: false, float: false},
       char2     : {channels: 2, size: 1*2, type: GL.BYTE          , norm: false, float: false},
       char4     : {channels: 4, size: 1*4, type: GL.BYTE          , norm: false, float: false},
      uchar2norm : {channels: 2, size: 1*2, type: GL.UNSIGNED_BYTE , norm: true , float: true },
      uchar4norm : {channels: 4, size: 1*4, type: GL.UNSIGNED_BYTE , norm: true , float: true },
       char2norm : {channels: 2, size: 1*2, type: GL.BYTE          , norm: true , float: true },
       char4norm : {channels: 4, size: 1*4, type: GL.BYTE          , norm: true , float: true },
      ushort2    : {channels: 2, size: 2*2, type: GL.UNSIGNED_SHORT, norm: false, float: false},
      ushort4    : {channels: 4, size: 2*4, type: GL.UNSIGNED_SHORT, norm: false, float: false},
       short2    : {channels: 2, size: 2*2, type: GL.SHORT         , norm: false, float: false},
       short4    : {channels: 4, size: 2*4, type: GL.SHORT         , norm: false, float: false},
      ushort2norm: {channels: 2, size: 2*2, type: GL.UNSIGNED_SHORT, norm: true , float: true },
      ushort4norm: {channels: 4, size: 2*4, type: GL.UNSIGNED_SHORT, norm: true , float: true },
       short2norm: {channels: 2, size: 2*2, type: GL.SHORT         , norm: true , float: true },
       short4norm: {channels: 4, size: 2*4, type: GL.SHORT         , norm: true , float: true },
      half2      : {channels: 2, size: 2*2, type: GL.HALF_FLOAT    , norm: false, float: true },
      half4      : {channels: 4, size: 2*4, type: GL.HALF_FLOAT    , norm: false, float: true },
      float      : {channels: 1, size: 4*1, type: GL.FLOAT         , norm: false, float: true },
      float2     : {channels: 2, size: 4*2, type: GL.FLOAT         , norm: false, float: true },
      float3     : {channels: 3, size: 4*3, type: GL.FLOAT         , norm: false, float: true },
      float4     : {channels: 4, size: 4*4, type: GL.FLOAT         , norm: false, float: true },
      uint       : {channels: 1, size: 4*1, type: GL.UNSIGNED_INT  , norm: false, float: false},
      uint2      : {channels: 2, size: 4*2, type: GL.UNSIGNED_INT  , norm: false, float: false},
      uint3      : {channels: 3, size: 4*3, type: GL.UNSIGNED_INT  , norm: false, float: false},
      uint4      : {channels: 4, size: 4*4, type: GL.UNSIGNED_INT  , norm: false, float: false},
       int       : {channels: 1, size: 4*1, type: GL.INT           , norm: false, float: false},
       int2      : {channels: 2, size: 4*2, type: GL.INT           , norm: false, float: false},
       int3      : {channels: 3, size: 4*3, type: GL.INT           , norm: false, float: false},
       int4      : {channels: 4, size: 4*4, type: GL.INT           , norm: false, float: false},
   };

   const BLEND_EQUATION = {
      'add'             : GL.FUNC_ADD,
      'subtract'        : GL.FUNC_SUBTRACT,
      'reverse-subtract': GL.FUNC_REVERSE_SUBTRACT,
      'min'             : GL.MIN,
      'max'             : GL.MAX,
   };
   const BLEND_FUNC = {
      'zero'                 : GL.ZERO,
      'one'                  : GL.ONE,
      'src-color'            : GL.SRC_COLOR,
      'one-minus-src-color'  : GL.ONE_MINUS_SRC_COLOR,
      'src-alpha'            : GL.SRC_ALPHA,
      'one-minus-src-alpha'  : GL.ONE_MINUS_SRC_ALPHA,
      'dst-color'            : GL.DST_COLOR,
      'one-minus-dst-color'  : GL.ONE_MINUS_DST_COLOR,
      'dst-alpha'            : GL.DST_ALPHA,
      'one-minus-dst-alpha'  : GL.ONE_MINUS_DST_ALPHA,
      'blend-color'          : GL.CONSTANT_COLOR,
      'one-minus-blend-color': GL.ONE_MINUS_CONSTANT_COLOR,
   };
   const COMPARE_FUNC = {
      'never'        : GL.NEVER,
      'less'         : GL.LESS,
      'equal'        : GL.EQUAL,
      'less-equal'   : GL.LEQUAL,
      'greater'      : GL.GREATER,
      'not-equal'    : GL.NOTEQUAL,
      'greater-equal': GL.GEAQUAL,
      'always'       : GL.ALWAYS,
   };
   const STENCIL_OP = {
      'keep'           : GL.KEEP,
      'zero'           : GL.ZERO,
      'replace'        : GL.REPLACE,
      'invert'         : GL.INVERT,
      'increment-clamp': GL.INCR,
      'decrement-clamp': GL.DECR,
      'increment-wrap' : GL.INCR_WRAP,
      'decrement-wrap' : GL.DECR_WRAP,
   };

   class GPURenderPipeline_JS {
      constructor(device, desc) {
         this.device = device;
         if (!desc)
            return;
         desc = make_GPURenderPipelineDescriptor(desc);
         this.desc = desc;

         const gl = this.device.gl;
         this.vao = gl.createVertexArray();
         gl.bindVertexArray(this.vao);

         const buff_list = this.desc.vertexInput.vertexBuffers;
         for (const buff_i in buff_list) {
            const buff_desc = buff_list[buff_i];
            const instance_divisor = (buff_desc.stepMode == 'instance' ? 1 : 0);
            for (const attrib of buff_desc.attributeSet) {
               gl.enableVertexAttribArray(attrib.shaderLocation);
               gl.vertexAttribDivisor(attrib.shaderLocation, instance_divisor);
               const format = VERTEX_FORMAT[attrib.format];

               attrib.set_buf_offset = (gpu_buf, buf_offset) => {
                  const gl_buf = gpu_buf ? gpu_buf.buf : null;
                  gl.bindBuffer(GL.ARRAY_BUFFER, gl_buf);
                  if (format.float) {
                     gl.vertexAttribPointer(attrib.shaderLocation, format.channels, format.type,
                                            format.norm, buff_desc.stride,
                                            buf_offset + attrib.offset);
                  } else {
                     gl.vertexAttribIPointer(attrib.shaderLocation, format.channels, format.type,
                                             buff_desc.stride,
                                             buf_offset + attrib.offset);
                  }
               };
            }
         }

         // -

         const prog = gl.createProgram();

         function attach_shader(type, pipe_stage_desc) {
            if (!pipe_stage_desc)
               return;
            const s = gl.createShader(type);
            gl.shaderSource(s, pipe_stage_desc.module.desc.code);
            gl.compileShader(s);
            gl.attachShader(prog, s);
            return s;
         }
         const vs = attach_shader(GL.VERTEX_SHADER, desc.vertexStage);
         const fs = attach_shader(GL.FRAGMENT_SHADER, desc.fragmentStage);
         gl.linkProgram(prog);

         const ok = gl.getProgramParameter(prog, gl.LINK_STATUS);
         if (!ok) {
            console.log('Error linking program:');
            console.log('\nLink log: ' + gl.getProgramInfoLog(prog));
            console.log('\nVert shader log: ' + gl.getShaderInfoLog(vs));
            if (fs) {
               console.log('\nFrag shader log: ' + gl.getShaderInfoLog(fs));
            }
         }
         gl.deleteShader(vs);
         if (fs) {
            gl.deleteShader(fs);
         }
         this.prog = prog;

         // -

         function equal_GPUBlendDescriptor(a, b) {
            return (a.srcFactor == b.srcFactor &&
                    a.dstFactor == b.dstFactor &&
                    a.operation == b.operation);
         }
         function is_trivial_blend(x) {
            return (x.srcFactor == 'one' &&
                    x.dstFactor == 'zero' &&
                    x.operation == 'add');
         }

         let example = null;
         let matching = true;
         desc.colorStates.forEach((cur, i) => {
            if (!example) {
               example = cur;
            }
            matching &= (equal_GPUBlendDescriptor(cur.alphaBlend, example.alphaBlend) &&
                         equal_GPUBlendDescriptor(cur.colorBlend, example.colorBlend) &&
                         cur.writeMask == example.writeMask);
         });
         ASSERT(matching, 'Differing alphaBlend, colorBlend, and writeMask not supported.');

         const has_blending = example && (!is_trivial_blend(example.alphaBlend) ||
                                          !is_trivial_blend(example.colorBlend));
         this._set_blend_and_mask = () => {
            if (example) {
               gl.colorMask(example.writeMask & GPUColorWriteBits.RED,
                            example.writeMask & GPUColorWriteBits.GREEN,
                            example.writeMask & GPUColorWriteBits.BLUE,
                            example.writeMask & GPUColorWriteBits.ALPHA);
            }
            if (has_blending) {
               gl.enable(GL.BLEND);
               gl.blendEquationSeparate(BLEND_EQUATION[example.colorBlend.operation],
                                        BLEND_EQUATION[example.alphaBlend.operation]);
               gl.blendFuncSeparate(BLEND_FUNC[example.colorBlend.srcFactor],
                                    BLEND_FUNC[example.colorBlend.dstFactor],
                                    BLEND_FUNC[example.alphaBlend.srcFactor],
                                    BLEND_FUNC[example.alphaBlend.dstFactor]);
            } else {
               gl.disable(GL.BLEND);
            }
         };

         this._set_stencil_ref = (ref) => {
            const ds_desc = desc.depthStencilState
            if (!ds_desc)
               return;
            gl.stencilFuncSeparate(GL.FRONT, COMPARE_FUNC[ds_desc.stencilFront.compare], ref,
                                   ds_desc.stencilReadMask);
            gl.stencilFuncSeparate(GL.BACK, COMPARE_FUNC[ds_desc.stencilBack.compare], ref,
                                   ds_desc.stencilReadMask);
         };
      }

      _setup(color_attachments, ds_attach_desc) {
         const gl = this.device.gl;

         gl.bindVertexArray(this.vao);
         gl.useProgram(this.prog);
         this._set_blend_and_mask();

         const rast = this.desc.rasterizationState;
         gl.frontFace(rast.frontFace == 'ccw' ? GL.CCW : GL.CW);
         if (rast.cullMode == 'none') {
            gl.disable(GL.CULL_FACE);
         } else {
            gl.enable(GL.CULL_FACE);
            gl.cullFace(rast.cullMode == 'back' ? GL.BACK : GL.FRONT);
         }
         gl.polygonOffset(rast.depthBias, rast.depthBiasSlopeScale);
         if (rast.depthBiasClamp) {
            console.log('depthBiasClamp unsupported');
         }

         if (this.desc.fragmentStage) {
            gl.disable(GL.RASTERIZER_DISCARD);

            const draw_bufs = [];
            for (let i in this.desc.colorStates) {
               i |= 0;
               const ca = color_attachments[i];
               ca._load_op();

               while (draw_bufs.length < i) {
                  draw_bufs.push(0);
               }
               if (ca.attachment.tex.swap_chain) {
                  draw_bufs.push(GL.BACK);
               } else {
                  draw_bufs.push(GL.COLOR_ATTACHMENT0 + i);
               }
            }
            gl.drawBuffers(draw_bufs);

            // -

            let depth_test = false;
            let stencil_test = false;
            const ds_desc = this.desc.depthStencilState;
            if (ds_desc) {
               depth_test = (ds_desc.depthCompare == 'always' &&
                             !ds_desc.depthWriteEnabled);
               stencil_test = (ds_desc.stencilFront.compare == 'always' &&
                               ds_desc.stencilBack.compare == 'always' &&
                               !ds_desc.stencilWriteMask);

               VALIDATE(ds_attach_desc, 'Pipeline has depth-stencil but render-pass does not.');
               ds_attach_desc._load_op();
            }

            if (depth_test) {
               gl.enable(gl.DEPTH_TEST);
               gl.depthMask(ds_desc.depthWriteEnabled);
               gl.depthFunc(COMPARE_FUNC[ds_desc.depthCompare]);
            } else {
               gl.disable(gl.DEPTH_TEST);
            }
            if (stencil_test) {
               gl.enable(gl.STENCIL_TEST);
               gl.stencilOpSeparate(GL.FRONT,
                                    STENCIL_OP[ds_desc.stencilFront.failOp],
                                    STENCIL_OP[ds_desc.stencilFront.depthFailOp],
                                    STENCIL_OP[ds_desc.stencilFront.passOp]);
               gl.stencilOpSeparate(GL.BACK,
                                    STENCIL_OP[ds_desc.stencilBack.failOp],
                                    STENCIL_OP[ds_desc.stencilBack.depthFailOp],
                                    STENCIL_OP[ds_desc.stencilBack.passOp]);
               gl.stencilMask(ds_desc.stencilWriteMask);
            } else {
               gl.disable(gl.STENCIL_TEST);
            }
         } else {
            gl.enable(GL.RASTERIZER_DISCARD);
         }

         if (this.desc.alphaToCoverageEnabled) {
            gl.enable(GL.SAMPLE_ALPHA_TO_COVERAGE);
         } else {
            gl.disable(GL.SAMPLE_ALPHA_TO_COVERAGE);
         }
      }

      _set_vert_buffers(set_list) {
         const buff_list = this.desc.vertexInput.vertexBuffers;
         for (const buff_i in buff_list) {
            if (!set_list[buff_i])
               continue;
            const [buf, buf_offset] = set_list[buff_i];
            const buff_desc = buff_list[buff_i];
            for (const attrib of buff_desc.attributeSet) {
               attrib.set_buf_offset(buf, buf_offset);
            }
         }
      }
   }

   function make_GPURenderPipelineDescriptor(desc) {
      desc = make_GPUPipelineDescriptorBase(desc);
      desc = Object.assign({
         fragmentStage: null,
         depthStencilState: null,
         sampleCount: 1,
         sampleMask: 0xFFFFFFFF,
         alphaToCoverageEnabled: false,
      }, desc);
      REQUIRE(desc, 'GPURenderPipelineDescriptor', 'vertexStage', null, make_GPUPipelineStageDescriptor);
      REQUIRE(desc, 'GPURenderPipelineDescriptor', 'primitiveTopology');
      REQUIRE(desc, 'GPURenderPipelineDescriptor', 'rasterizationState', null, make_GPURasterizationStateDescriptor);
      REQUIRE_SEQ(desc, 'GPURenderPipelineDescriptor', 'colorStates', null, make_GPUColorStateDescriptor);
      REQUIRE(desc, 'GPURenderPipelineDescriptor', 'vertexInput', null, make_GPUVertexInputDescriptor);
      if (desc.fragmentStage) {
         desc.fragmentStage = make_GPUPipelineStageDescriptor(desc.fragmentStage);
      }
      return desc;
   }
   function make_GPURasterizationStateDescriptor(desc) {
      desc = Object.assign({
         frontFace: 'ccw',
         cullMode: 'none',
         depthBias: 0,
         depthBiasSlopeScale: 0,
         depthBiasClamp: 0,
      }, desc);
      return desc;
   }
   function make_GPUColorStateDescriptor(desc) {
      desc = Object.assign({
         writeMask: GPUColorWriteBits.ALL,
      }, desc);
      REQUIRE(desc, 'GPUColorStateDescriptor', 'format');
      REQUIRE(desc, 'GPUColorStateDescriptor', 'alphaBlend', null, make_GPUBlendDescriptor);
      REQUIRE(desc, 'GPUColorStateDescriptor', 'colorBlend', null, make_GPUBlendDescriptor);
      return desc;
   }
   function make_GPUBlendDescriptor(desc) {
      desc = Object.assign({
         srcFactor: 'one',
         dstFactor: 'zero',
         operation: 'add',
      }, desc);
      return desc;
   }
   function make_GPUDepthStencilStateDescriptor(desc) {
      desc = Object.assign({
         depthWriteEnabled: false,
         depthCompare: 'always',
         stencilReadMask: 0xFFFFFFFF,
         stencilWriteMask: 0xFFFFFFFF,
      }, desc);
      REQUIRE(desc, 'GPUDepthStencilStateDescriptor', 'format');
      REQUIRE(desc, 'GPUDepthStencilStateDescriptor', 'stencilFront', null, make_GPUStencilStateFaceDescriptor);
      REQUIRE(desc, 'GPUDepthStencilStateDescriptor', 'stencilBack', null, make_GPUStencilStateFaceDescriptor);
      return desc;
   }
   function make_GPUStencilStateFaceDescriptor(desc) {
      desc = Object.assign({
         compare: 'always',
         failOp: 'keep',
         depthFailOp: 'keep',
         passOp: 'keep',
      }, desc);
      return desc;
   }
   function make_GPUVertexInputDescriptor(desc) {
      desc = Object.assign({
         indexFormat: 'uint32',
      }, desc);
      REQUIRE_SEQ(desc, 'GPUVertexInputDescriptor ', 'vertexBuffers', null, make_nullable_GPUVertexBufferDescriptor);
      return desc;
   }
   function make_nullable_GPUVertexBufferDescriptor(desc) {
      if (!desc)
         return null;
      desc = Object.assign({
         stepMode: 'vertex',
      }, desc);
      REQUIRE(desc, 'GPUVertexBufferDescriptor', 'stride');
      REQUIRE_SEQ(desc, 'GPUVertexBufferDescriptor ', 'attributeSet', null, make_GPUVertexAttributeDescriptor);
      return desc;
   }
   function make_GPUVertexAttributeDescriptor(desc) {
      desc = Object.assign({
         offset: 0,
      }, desc);
      REQUIRE(desc, 'GPUVertexAttributeDescriptor', 'format');
      REQUIRE(desc, 'GPUVertexAttributeDescriptor', 'shaderLocation');
      return desc;
   }

   // -

   function make_GPUPipelineStageDescriptor(desc) {
      desc = Object.assign({
      }, desc);
      REQUIRE(desc, 'GPUPipelineStageDescriptor', 'module', GPUShaderModule_JS);
      REQUIRE_VAL(desc, 'GPUPipelineStageDescriptor', 'entryPoint', 'main');
      return desc;
   }
   function make_GPUPipelineDescriptorBase(desc) {
      desc = Object.assign({
      }, desc);
      REQUIRE(desc, 'GPUPipelineDescriptorBase', 'layout', GPUPipelineLayout_JS);
      return desc;
   }

   // -

   class GPUProgrammablePassEncoder_JS {
      constructor(cmd_enc) {
         this.cmd_enc = cmd_enc;
      }

      endPass() {
         try {
            if (this.cmd_enc.in_pass == this) {
               this.cmd_enc.in_pass = null;
            }
         } catch (e) { this.cmd_enc.device._catch(e); }
      }
   }

   function make_GPURenderPassColorAttachmentDescriptor(desc) {
      desc = Object.assign({
         resolveTarget: null,
         clearColor: [0,0,0,1],
      }, desc);
      REQUIRE(desc, 'GPURenderPassColorAttachmentDescriptor', 'attachment', GPUTextureView_JS);
      REQUIRE(desc, 'GPURenderPassColorAttachmentDescriptor', 'loadOp');
      REQUIRE(desc, 'GPURenderPassColorAttachmentDescriptor', 'storeOp');
      desc.clearColor = make_GPUColor(desc.clearColor);
      return desc;
   }

   function make_GPURenderPassDepthStencilAttachmentDescriptor(desc) {
      if (!desc)
         return null;
      desc = Object.assign({
         clearStencil: 0,
      }, desc);
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'attachment', GPUTextureView_JS);
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'depthLoadOp');
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'depthStoreOp');
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'clearDepth');
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'stencilLoadOp');
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'stencilStoreOp');
      return desc;
   }

   function make_GPURenderPassDescriptor(desc) {
      desc = Object.assign({
         depthStencilAttachment: make_GPURenderPassDepthStencilAttachmentDescriptor(desc.depthStencilAttachment),
      }, desc);
      REQUIRE_SEQ(desc, 'GPURenderPassDescriptor ', 'colorAttachments', null, make_GPURenderPassColorAttachmentDescriptor);
      return desc;
   }

   const INDEX_FORMAT = {
      uint16: {type: GL.UNSIGNED_SHORT, size: 2},
      uint32: {type: GL.UNSIGNED_INT, size: 4},
   };

   class GPURenderPassEncoder_JS extends GPUProgrammablePassEncoder_JS {
      constructor(cmd_enc, desc) {
         super(cmd_enc);
         this.cmd_enc = cmd_enc;
         if (!desc)
            return;
         desc =  make_GPURenderPassDescriptor(desc);
         this.desc = desc;

         const device = cmd_enc.device;
         const gl = device.gl;

         this.fb = null;
         if (desc.colorAttachments.length == 1 &&
            desc.colorAttachments[0].attachment.tex.swap_chain) {
         } else {
            this.fb = gl.createFramebuffer();
         }
         gl.bindFramebuffer(GL.FRAMEBUFFER, this.fb);

         desc.colorAttachments.forEach((x, i) => {
            const view = x.attachment;
            const tex = view.tex;
            if (x.loadOp == 'clear') {
               const color = [
                  x.clearColor.r,
                  x.clearColor.g,
                  x.clearColor.b,
                  x.clearColor.a,
               ];
               const format = tex.desc.format;
               let fn_clear = gl.clearBufferfv;
               if (format.includes('sint')) {
                  fn_clear = gl.clearBufferiv;
               } else if (format.includes('uint')) {
                  fn_clear = gl.clearBufferuiv;
               }
               let did_load = false;
               x._load_op = () => {
                  if (did_load)
                     return;
                  did_load = true;
                  //console.log('clear', i, color);
                  fn_clear.call(gl, GL.COLOR, i, color);
               };
            } else {
               x._load_op = () => {};
            }

            if (this.fb) {
               if (tex.target == GL.TEXTURE_2D) {
                  gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0 + i,
                                          tex.target, tex.tex, view.desc.baseMipLevel);
               } else if (tex.target == GL.TEXTURE_CUBE_MAP) {
                  gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0 + i,
                                          TEXTURE_CUBE_MAP_POSITIVE_X + view.desc.baseArrayLayer,
                                          tex.tex, view.desc.baseMipLevel);
               } else if (tex.target == GL.TEXTURE_3D ||
                          tex.target == GL.TEXTURE_2D_ARRAY) {
                  gl.framebufferTextureLayer(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0 + i,
                                             tex.tex, view.desc.baseMipLevel, view.desc.baseArrayLayer);
               }
            }
         });

         const DEPTH_STENCIL_FORMAT = {
            'depth32float': {depth: true},
            'depth24plus': {depth: true},
            'depth24plus-stencil8': {depth: true, stencil: true},
            'r8sint': {stencil: true}, // Maybe?
         };
         const DEPTH_STENCIL_ASPECT = {
            'depth-only': {depth: true},
            'stencil-only': {stencil: true},
         };

         const ds_attach_desc = desc.depthStencilAttachment;
         if (ds_attach_desc) {
            let ds_info = DEPTH_STENCIL_ASPECT[ds_attach_desc.attachment.desc.aspect];
            if (!ds_info) {
               ds_info = DEPTH_STENCIL_FORMAT[ds_attach_desc.attachment.desc.format];
            }
            let did_load = false;
            ds_attach_desc._load_op = () => {
               if (did_load)
                  return;
               did_load = true;
               const clear_depth = (ds_info.depth && ds_attach_desc.depthLoadOp == 'clear');
               const clear_stencil = (ds_info.stencil && ds_attach_desc.stencilLoadOp == 'clear');
               if (clear_depth) {
                  gl.depthMask(true);
                  if (!clear_stencil) {
                     gl.clearBufferfv(GL.DEPTH, 0, [ds_attach_desc.clearDepth]);
                  }
               }
               if (clear_stencil) {
                  gl.stencilMask(0xffffffff);
                  if (clear_depth) {
                     gl.clearBufferfi(GL.DEPTH_STENCIL, 0, ds_attach_desc.clearDepth, ds_attach_desc.clearStencil);
                  } else {
                     gl.clearBufferiv(GL.STENCIL, 0, [ds_attach_desc.clearStencil]);
                  }
               }
            };
         }

         this._vert_buf_list = [];

         const attachment = desc.depthStencilAttachment || desc.colorAttachments[0];
         const size = attachment.attachment.tex.desc.size;

         this.setBlendColor([1, 1, 1, 1]);
         this.setStencilReference(0);
         this.setViewport(0, 0, size.width, size.height, 0, 1);
         this.setScissorRect(0, 0, size.width, size.height);
         this.setIndexBuffer(0, [], []);
         this.setVertexBuffers(0, [], []);
      }

      setPipeline(pipeline) {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            this.cmd_enc._add(() => {
               this._pipeline = pipeline;
               this._pipeline_ready = false;
               this._vert_bufs_ready = false;
               this._stencil_ref_ready = false;
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }
      setBlendColor(color) {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            color = make_GPUColor(color);
            this.cmd_enc._add(() => {
               const gl = this.cmd_enc.device.gl;
               gl.blendColor(color.r, color.g, color.b, color.a);
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }
      setStencilReference(ref) {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            this.cmd_enc._add(() => {
               this._stencil_ref = ref;
               this._stencil_ref_ready = false;
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }

      setViewport(x, y, w, h, min_depth, max_depth) {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            this.cmd_enc._add(() => {
               const gl = this.cmd_enc.device.gl;
               gl.viewport(x, y, w, h);
               gl.depthRange(min_depth, max_depth);
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }

      setScissorRect(x, y, w, h) {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            this.cmd_enc._add(() => {
               const gl = this.cmd_enc.device.gl;
               gl.scissor(x, y, w, h);
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }

      setIndexBuffer(buffer, offset) {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            this.cmd_enc._add(() => {
               const gl = this.cmd_enc.device.gl;
               const gl_buf = buffer ? buffer.buf : null;
               gl.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, gl_buf);
               this._index_buf_offset = offset;
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }
      setVertexBuffers(start_slot, buffers, offsets) {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            this.cmd_enc._add(() => {
               for (let i in buffers) {
                  i |= 0; // Arr ids are strings! 0 + '0' is '00'!
                  const slot = start_slot + i;
                  this._vert_buf_list[slot] = [buffers[i], offsets[i]];
               }
               this._vert_bufs_ready = false;
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }

      _pre_draw() {
         if (!this._pipeline_ready) {
            this._pipeline._setup(this.desc.colorAttachments, this.desc.depthStencilAttachment);
            this._pipeline_ready = true;
         }
         if (!this._vert_bufs_ready) {
            this._pipeline._set_vert_buffers(this._vert_buf_list);
            this._vert_bufs_ready = true;
         }
         if (!this._stencil_ref_ready) {
            this._pipeline._set_stencil_ref(this._stencil_ref);
            this._stencil_ref_ready = true;
         }
      }

      draw(vert_count, inst_count, base_vert, base_inst) {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(base_inst == 0, 'firstInstance must be 0');
            this.cmd_enc._add(() => {
               this._pre_draw();

               const gl = this.cmd_enc.device.gl;
               const prim_topo = PRIM_TOPO[this._pipeline.desc.primitiveTopology];
               gl.drawArraysInstanced(prim_topo, base_vert, vert_count, inst_count);
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }
      drawIndexed(index_count, inst_count, base_index, base_vert, base_inst) {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(base_inst == 0, 'firstInstance must be 0');
            this.cmd_enc._add(() => {
               this._pre_draw();

               const gl = this.cmd_enc.device.gl;
               const prim_topo = PRIM_TOPO[this._pipeline.desc.primitiveTopology];
               const format = INDEX_FORMAT[this._pipeline.desc.vertexInput.indexFormat];
               const offset = this._index_buf_offset + base_index * format.size;
               gl.drawElementsInstanced(prim_topo, index_count, format.type, offset, inst_count);
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }

      endPass() {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            this.cmd_enc._add(() => {
               for (const x of this.desc.colorAttachments) {
                  x._load_op();
               }
            });
            super.endPass();
         } catch (e) { this.cmd_enc.device._catch(e); }
      }
   }

   // -


   class GPUCommandBuffer_JS {
      constructor(device, enc) {
         this.device = device;
         this.enc = enc;
      }
   }

   class GPUCommandEncoder_JS {
      constructor(device, desc) {
         this.device = device;
         if (!desc)
            return;
         desc = make_GPUCommandEncoderDescriptor(desc);
         this.desc = desc;

         this.in_pass = null;
         this.is_finished = false;
         this.cmds = [];
      }

      _add(fn_cmd) {
         this.cmds.push(fn_cmd);
      }

      beginRenderPass(desc) {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(!this.in_pass, 'endPass not called.');
            VALIDATE(!this.is_finished, 'Already finished.');
            REQUIRE_NON_NULL(desc, 'GPURenderPassDescriptor');
            const ret = new GPURenderPassEncoder_JS(this, desc);
            this.in_pass = ret;
            return ret;
         } catch (e) {
            this.device._catch(e);
            return new GPURenderPassEncoder_JS(this, null);
         }
      }

      finish() {
         try {
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(!this.in_pass, 'endPass not called.');
            VALIDATE(!this.is_finished, 'Already finished.');
            this.is_finished = true;
            return new GPUCommandBuffer_JS(this.device, this);
         } catch (e) {
            this.device._catch(e);
            return new GPUCommandBuffer_JS(this.device, null);
         }
      }
   }

   function make_GPUCommandEncoderDescriptor(desc) {
      desc = Object.assign({
      }, desc);
      return desc;
   }

   // -

   function make_GPUShaderModuleDescriptor(desc) {
      REQUIRE(desc, 'GPUShaderModuleDescriptor', 'code');
      desc = Object.assign({
      }, desc);
      return desc;
   }

   class GPUShaderModule_JS {
      constructor(device, desc) {
         this.device = device;
         if (!desc)
            return;
         desc = make_GPUShaderModuleDescriptor(desc);
         this.desc = desc;
      }
   }

   // -

   class GPUQueue_JS {
      constructor(device) {
         this.device = device;
      }

      submit(buffers) {
         try {
            buffers.forEach(cmd_buf => {
               const cmds = cmd_buf.enc.cmds;
               cmds.forEach(x => {
                  x();
               })
            });
         } catch (e) { this.device._catch(e); }
      }
   }

   // -
   function make_GPUExtensions(dict) {
      return Object.assign({
         anisotropicFiltering: false,
      }, dict);
   }

   function make_GPULimits(dict) {
      return Object.assign({
         maxBindGroups: 4,
      }, dict);
   }

   function make_GPUDeviceDescriptor(desc) {
      desc.extensions = make_GPUExtensions(desc.extensions);
      desc.limits = make_GPULimits(desc.limits);
      return desc;
   }

   class GPUDeviceLostInfo_JS {
      constructor(message) {
         this._message = message.slice();
      }

      get message() { return this._message; }
   }

   const FILTER_TYPE = {
      'out-of-memory': 'GPUOutOfMemoryError',
      'validation'   : 'GPUValidationError',
   };

   if (window.GPUUncapturedErrorEvent === undefined) {
      window.GPUUncapturedErrorEvent = class GPUUncapturedErrorEvent extends Event {
         constructor(type_str, init_dict) {
            super(type_str, init_dict);
            ASSERT(init_dict.error, '`GPUUncapturedErrorEventInit.error` required.');
            this._error = init_dict.error;
         }

         get error() {
            return this._error;
         }

         toString() {
            return 'GPUUncapturedErrorEvent: ' + this.error.toString();
         }
      };
   }

   class GPUDevice_JS extends EventTarget {
      constructor(adapter, desc) {
         super();
         this._adapter = adapter;
         desc = make_GPUDeviceDescriptor(desc);
         this.desc = desc;

         this._gl = null;
         this._is_lost = false;
         this._lost = new Promise((yes, no) => {
            this.resolve_lost = () => {
               this.is_lost = true;
               yes();
            };
         });

         this._queue = new GPUQueue_JS(this);
         this._error_scopes = [];
      }

      get adapter() { return this._adapter; }
      get extensions() { return this.gl_info.extensions; }
      get limits() { return this.gl_info.limits; }
      get lost() { return this._lost; }

      lose() {
         this.resolve_lost();
      }

      _ensure_gl(c) {
         if (!this._gl) {
            this._gl = (() => {
               const adapter = this.adapter;
               const gl = adapter.make_gl(c);
               if (!gl) {
                  console.log('Failed to make_gl.');
                  return null;
               }

               const gl_info = new GlInfo(gl);

               if (!is_subset(gl_info.extensions, adapter.last_info.extensions)) {
                  console.log('`extensions` not a subset of adapters\'.');
                  return null;
               }

               if (!is_subset(gl_info.limits, adapter.last_info.limits)) {
                  console.log('`limits` not a subset of adapters\'.');
                  return null;
               }
               return gl;
            })();
            if (!this._gl) {
               this.lose();
            }
         }
         return this._gl;
      }

      get gl() {
         return this._ensure_gl();
      }

      // -

      createBuffer(desc) {
         try {
            REQUIRE_NON_NULL(desc, 'GPUBufferDescriptor');
            return new GPUBuffer_JS(this, desc, false);
         } catch (e) {
            this._catch(e);
            return new GPUBuffer_JS(this, null);
         }
      }
      createBufferMapped(desc) {
         try {
            REQUIRE_NON_NULL(desc, 'GPUBufferDescriptor');
            const buf = new GPUBuffer_JS(this, desc, true);
            const init_map = buf._map_write();
            return [buf, init_map];
         } catch (e) {
            this._catch(e);
            return new GPUBuffer_JS(this, null);
         }
      }
      createBufferMappedAsync(desc) {
         try {
            REQUIRE_NON_NULL(desc, 'GPUBufferDescriptor');
            const ret = this.createBufferMapped(desc);
            return new Promise((good, bad) => {
               good(ret);
            });
         } catch (e) {
            this._catch(e);
            return new GPUBuffer_JS(this, null);
         }
      }
      createTexture(desc) {
         try {
            REQUIRE_NON_NULL(desc, 'GPUTextureDescriptor');
            return new GPUTexture_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPUTexture_JS(this, null);
         }
      }

      createBindGroupLayout(desc) {
         try {
            REQUIRE_NON_NULL(desc, 'GPUBindGroupLayoutDescriptor');
            return new GPUBindGroupLayout_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPUBindGroupLayout_JS(this, null);
         }
      }
      createPipelineLayout(desc) {
         try {
            REQUIRE_NON_NULL(desc, 'GPUPipelineLayoutDescriptor');
            return new GPUPipelineLayout_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPUPipelineLayout_JS(this, null);
         }
      }

      createShaderModule(desc) {
         try {
            REQUIRE_NON_NULL(desc, 'GPUShaderModuleDescriptor');
            return new GPUShaderModule_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPUShaderModule_JS(this, null);
         }
      }
      createRenderPipeline(desc) {
         try {
            REQUIRE_NON_NULL(desc, 'GPURenderPipelineDescriptor');
            return new GPURenderPipeline_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPURenderPipeline_JS(this, null);
         }
      }

      createCommandEncoder(desc) {
         try {
            REQUIRE_NON_NULL(desc, 'GPUCommandEncoderDescriptor');
            return new GPUCommandEncoder_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPUCommandEncoder_JS(this, null);
         }
      }

      getQueue() {
         return this._queue;
      }

      // -

      pushErrorScope(filter) {
         const new_scope = {
            filter: FILTER_TYPE[filter],
            error: null,
         };
         this._error_scopes.unshift(new_scope);
      }

      popErrorScope() {
         return new Promise((good, bad) => {
            if (this._is_lost)
               return bad('Device lost.');
            if (!this._error_scopes.length)
               return bad('Error scope stack is empty.');
            const popped = this._error_scopes.shift();
            if (!popped.error)
               return bad('Top of stack has no error.');
            good(popped.error);
         });
      }

      _catch(error) {
         if (!IS_GPU_ERROR[error.name]) throw error;

         for (const scope of this._error_scopes) {
            if (error.name != scope.filter)
               continue;

            if (!scope.error) { // Only capture the first.
               scope.error = error;
            }
            return;
         }

         const dispatch = () => {
            const event = new GPUUncapturedErrorEvent('uncapturederror', {
               error: error,
            });
            if (this.dispatchEvent(event)) {
               console.error(error.toString());
            }
         }
         if (SYNC_ERROR_DISPATCH) {
            dispatch();
         } else {
            setZeroTimeout(dispatch); // Dispatch async
         }
      }
   }


   class GPUAdapter_JS {
      constructor() {}

      get name() { return this.last_info.name; }
      get extensions() { return this.last_info.extensions; }

      requestDevice(desc) {
         return new Promise((yes, no) => {
            const ret = new GPUDevice_JS(this, desc);
            if (!is_subset(ret.desc.extensions, this.last_info.extensions))
               return no('`extensions` not a subset of adapters\'.');

            if (!is_subset(ret.desc.limits, this.last_info.limits))
               return no('`limits` not a subset of adapters\'.');

            yes(ret);
         });
      }

      make_gl(for_canvas) {
         let c = for_canvas;
         if (!c) {
            c = document.createElement('canvas');
            c.width = 1;
            c.height = 1;
         }
         return ORIG_GET_CONTEXT.call(c, 'webgl2', {
            antialias: false,
            alpha: true,
            depth: true,
            stencil: true,
            premultipliedAlpha: false,
            powerPreference: this.desc.powerPreference,
         });
      }
   }

   class GPU_JS {
      requestAdapter(desc) {
         desc = Object.assign({}, desc);
         if (!desc.powerPreference) {
            desc.powerPreference = 'default'; // map to webgl
         }

         return new Promise((yes, no) => {
            const ret = new GPUAdapter_JS();
            ret.desc = desc;
            const gl = ret.make_gl();
            if (!gl)
               return no('WebGL 2 required.');

            ret.last_info = new GlInfo(gl);
            lose_gl(gl);

            yes(ret);
         });
      }
   }

   // -

   function make_GPUSwapChainDescriptor(desc) {
      REQUIRE(desc, 'GPUSwapChainDescriptor', 'device', GPUDevice_JS);
      REQUIRE(desc, 'GPUSwapChainDescriptor', 'format');
      desc = Object.assign({
         usage: GPUTextureUsage.OUTPUT_ATTACHMENT,
      }, desc);
      return desc;
   }

   class GPUSwapChain_JS {
      constructor(context, desc) {
         this.context = context;
         this.desc = desc;
      }

      getCurrentTexture() {
         if (!this.tex) {
            if (!this.context)
               throw new Error('Out-of-date swap chain');

            const canvas = this.context.canvas;
            const desc = {
               size: [canvas.width, canvas.height, 1],
               format: this.desc.format,
               usage: this.desc.usage,
            };
            let sc_if_fast = null;
            if (canvas == this.desc.device.gl.canvas) {
               sc_if_fast = this;
            }
            this.tex = new GPUTexture_JS(this.desc.device, desc, sc_if_fast);
         }
         return this.tex;
      }
   }

   // -

   class GPUCanvasContext_JS {
      constructor(canvas) {
         this.canvas = canvas;
         this.gl = null;
         this.swap_chain = null;
      }

      getSwapChainPreferredFormat(device) {
         return new Promise((yes, no) => {
            return yes('rgba8unorm');
         });
      }

      configureSwapChain(desc) {
         if (this.swap_chain) {
            this.swap_chain.context = null;
            this.swap_chain = null;
         }
         desc = make_GPUSwapChainDescriptor(desc);

         this.gl = desc.device._ensure_gl(this.canvas);
         if (this.gl.canvas != this.canvas) {
            console.log('Slowpath: configureSwapChain called after GL creation for GPUDevice.');
            this.gl = desc.device.adapter.make_gl(this.canvas);
         }
         if (!this.gl)
            return null;

         this.swap_chain = new GPUSwapChain_JS(this, desc);
         return this.swap_chain;
      }
   }

   HTMLCanvasElement.prototype.getContext = function(type) {
      const type_gpu = (type == 'gpu');
      if (this._gpu_js) {
         if (!type_gpu) return null;
         return this._gpu_js;
      }

      let ret = ORIG_GET_CONTEXT.apply(this, arguments);
      if (!ret && type_gpu) {
         ret = new GPUCanvasContext_JS(this);
         this._gpu_js = ret;
      }
      return ret;
   };

   return new GPU_JS();
})();

if (!navigator.gpu) {
   navigator.gpu = navigator.gpu_js;
}
