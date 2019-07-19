if (window.GPUBufferUsage === undefined) {
   GPUBufferUsage = {
      NONE     : 0x0000,
      MAP_READ : 0x0001,
      MAP_WRITE: 0x0002,
      COPY_SRC : 0x0004,
      COPY_DST : 0x0008,
      INDEX    : 0x0010,
      VERTEX   : 0x0020,
      UNIFORM  : 0x0040,
      STORAGE  : 0x0080,
   };
}
if (window.GPUTextureUsage === undefined) {
   GPUTextureUsage = {
      NONE              : 0x00,
      COPY_SRC          : 0x01,
      COPY_DST          : 0x02,
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

   function console_error_passthrough(e) {
      console.error(e);
      return e;
   }

   function ASSERT(val, info) {
      if (!val) throw console_error_passthrough(new Error('ASSERT: ' + info));
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
      if (!desc) throw console_error_passthrough(new TypeError(name + ' shall not be null.'));
   }

   function REQUIRE(dict, type, key, val_type, fn_map) {
      const name = '`' + type + '.' + key + '`';
      if (dict[key] === undefined) throw console_error_passthrough(new ReferenceError(name + ' required.'));
      if (val_type) {
         if (!(dict[key] instanceof val_type)) {
            throw console_error_passthrough(new TypeError(name + ' must be `' + val_type.name + '`.'));
         }
      }
      if (fn_map) {
         dict[key] = fn_map(dict[key]);
      }
   }

   function REQUIRE_SEQ(dict, type, key, val_type, fn_map) {
      const name = '`' + type + '.' + key + '`';
      if (dict[key] === undefined) throw console_error_passthrough(new ReferenceError(name + ' required.'));
      if (dict[key].length === undefined) throw console_error_passthrough(new TypeError(name + ' must be a sequence.'));
      const seq = dict[key];
      for (const i in seq) {
         const name_i = type + '.' + key + '[' + i + ']';
         if (val_type) {
            if (!(seq[i] instanceof val_type)) {
               throw new console_error_passthrough(TypeError(name + ' must be `' + val_type.name + '`.'));
            }
         }
         if (fn_map) {
            seq[i] = fn_map(seq[i]);
         }
      }
   }

   function REQUIRE_VAL(dict, type, key, val) {
      const name = '`' + type + '.' + key + '`';
      if (dict[key] !== val) throw console_error_passthrough(new Error(name + ' must be ' + val));
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
            this._gl_obj = gl.createBuffer();
            gl.bindBuffer(this._gl_target, this._gl_obj);

            let err = gl.getError();
            ASSERT(!err, 'Unexpected WebGL error: 0x' + err.toString(16));
            gl.bufferData(this._gl_target, desc.size, this._gl_usage);
            err = gl.getError();
            if (err == GL.OUT_OF_MEMORY) {
               while (gl.getError()) {}
               this.desc = null;
               throw new GPUOutOfMemoryError();
            }
            ASSERT(!err, 'Unexpected WebGL error: 0x' + err.toString(16));

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
            VALIDATE(!this.device._is_lost, 'Device is lost.');
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
            VALIDATE(!this.device._is_lost, 'Device is lost.');
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
               gl.bindBuffer(this._gl_target, this._gl_obj);
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
            VALIDATE(!this.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(this._map_ready, 'unmap() target must be presently mapped.');

            if (this._read_map) {
               this._read_map = null;
               return;
            }

            const gl = this.device.gl;
            if (!this._gl_obj) {
               this._gl_obj = gl.createBuffer();
               gl.bindBuffer(this._gl_target, this._gl_obj);

               let err = gl.getError();
               ASSERT(!err, 'Unexpected WebGL error: 0x' + err.toString(16));
               gl.bufferData(this._gl_target, this._write_map, this._gl_usage);
               if (gl.getError() == GL.OUT_OF_MEMORY)
                  throw new GPUOutOfMemoryError();

               gl.bindBuffer(this._gl_target, null);
            } else {
               gl.bindBuffer(this._gl_target, this._gl_obj);
               gl.bufferSubData(this._gl_target, 0, this._write_map);
               gl.bindBuffer(this._gl_target, null);
            }
            this._write_map = null;
         } catch (e) { this.device._catch(e); }
      }

      destroy() {
         try {
            VALIDATE(!this.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(!this._mapped(), 'Cannot be mapped.');
            if (this._gl_obj) {
               const gl = this.device.gl;
               gl.deleteBuffer(this._gl_obj);
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

   function make_GPUSamplerDescriptor(desc) {
      desc = Object.assign({
         addressModeU: 'clamp-to-edge',
         addressModeV: 'clamp-to-edge',
         addressModeW: 'clamp-to-edge',
         magFilter: 'nearest',
         minFilter: 'nearest',
         mipmapFilter: 'nearest',
         lodMinClamp: 0,
         lodMaxClamp: 0xffffffff,
         compare: 'never',
      }, desc);
      return desc;
   }

   const WRAP_MODE = {
      'clamp-to-edge': GL.CLAMP_TO_EDGE,
      'repeat': GL.REPEAT,
      'mirror-repeat': GL.MIRROR,
   };

   const FILTER_MODE = {
      nearest: GL.NEAREST,
      linear: GL.LINEAR,
   };
   const FILTER_MODE_KEY = {
      nearest: 'NEAREST',
      linear: 'LINEAR',
   };

   class GPUSampler_JS {
      constructor(device, desc) {
         this.device = device;
         if (!desc)
            return;
         desc = make_GPUSamplerDescriptor(desc);
         this.desc = desc;

         const gl = this.device.gl;
         this._gl_obj = gl.createSampler();

         const param = (name, map, pname) => {
            ASSERT(pname, 'pname');
            const val = desc[name];
            const mapped = map[val];
            VALIDATE(mapped, name + ' invalid: ' + val);
            gl.samplerParameteri(this._gl_obj, pname, mapped);
         };
         param('addressModeU', WRAP_MODE, GL.TEXTURE_WRAP_S);
         param('addressModeV', WRAP_MODE, GL.TEXTURE_WRAP_T);
         param('addressModeW', WRAP_MODE, GL.TEXTURE_WRAP_R);
         param('magFilter', FILTER_MODE, GL.TEXTURE_MAG_FILTER);

         const min = FILTER_MODE_KEY[desc.minFilter];
         const mipmap = FILTER_MODE_KEY[desc.mipmapFilter];
         VALIDATE(min, 'minFilter invalid: ' + min);
         VALIDATE(mipmap, 'mipmapFilter invalid: ' + mipmap);
         const key = min + '_MIPMAP_' + mipmap;
         gl.samplerParameteri(this._gl_obj, GL.TEXTURE_MIN_FILTER, GL[key]);

         gl.samplerParameterf(this._gl_obj, GL.TEXTURE_MIN_LOD, desc.lodMinClamp);
         gl.samplerParameterf(this._gl_obj, GL.TEXTURE_MAX_LOD, desc.lodMaxClamp);

         if (desc.compare != 'never') {
            param('compare', COMPARE_FUNC, GL.TEXTURE_COMPARE_FUNC);
            gl.samplerParameteri(this._gl_obj, GL.TEXTURE_COMPARE_MODE, GL.COMPARE_REF_TO_TEXTURE);
         }
      }
   }

   // -------

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

   const TEX_TARGET_BY_VIEW_DIM = {
      '1d': GL.TEXTURE_2D,
      '2d': GL.TEXTURE_2D,
      '2d-array': GL.TEXTURE_2D_ARRAY,
      'cube': GL.TEXTURE_CUBE_MAP,
      //'cube-array': GL.TEXTURE_2D_ARRAY,
      '3d': GL.TEXTURE_3D,
   };

   class GPUTextureView_JS {
      constructor(tex, desc) {
         this.tex = tex;
         if (!desc)
            return;
         desc = make_GPUTextureViewDescriptor(desc);
         this.desc = desc;
         ASSERT(desc.baseArrayLayer == 0, 'Not supported: baseArrayLayer > 0');
         ASSERT(desc.arrayLayerCount == tex.desc.arrayLayerCount,
                'Not supported: GPUTextureViewDescriptor.arrayLayerCount != GPUTextureDescriptor.arrayLayerCount');

         this._depth = tex._depth;
         this._stencil = tex._stencil;
         if (desc.aspect == 'depth-only') {
            this._stencil = undefined;
         } else if (desc.aspect == 'stencil-only') {
            this._depth = undefined;
         }
      }

      _bind_texture() {
         const gl = this.tex.device.gl;
         const gl_obj = this.tex._ensure_tex(this.desc.dimension);
         gl.bindTexture(gl_obj.target, gl_obj);
         gl.texParameteri(gl_obj.target, GL.TEXTURE_BASE_LEVEL, this.desc.baseMipLevel);
         gl.texParameteri(gl_obj.target, GL.TEXTURE_MAX_LEVEL, this.desc.baseMipLevel + this.desc.mipLevelCount);
      }

      _framebuffer_attach(fb_target, attachment_enum) {
         const gl = this.tex.device.gl;
         const tex = this.tex;

         if (tex.swap_chain) {
            // We'll need a temp.
            console.error('Creating temporary rendertarget for SwapChain.');
         }
         const gl_obj = tex._ensure_tex();
         const tex_target = gl_obj.target;
         if (tex_target == GL.TEXTURE_2D) {
            gl.framebufferTexture2D(fb_target, attachment_enum,
                                    tex_target, gl_obj, this.desc.baseMipLevel);
         } else if (tex_target == GL.TEXTURE_CUBE_MAP) {
            gl.framebufferTexture2D(fb_target, attachment_enum,
                                    TEXTURE_CUBE_MAP_POSITIVE_X + this.desc.baseArrayLayer,
                                    gl_obj, this.desc.baseMipLevel);
         } else if (tex_target == GL.TEXTURE_3D ||
                    tex_target == GL.TEXTURE_2D_ARRAY) {
            gl.framebufferTextureLayer(fb_target, attachment_enum,
                                       gl_obj, this.desc.baseMipLevel, this.desc.baseArrayLayer);
         } else {
            ASSERT(false, 'Bad target: 0x' + tex_target.toString(16));
         }
      }

      _bind_as_draw_fb() {
         const gl = this.tex.device.gl;
         ASSERT(this.desc.arrayLayerCount == 1, 'desc.arrayLayerCount: 1');
         ASSERT(this.desc.mipLevelCount == 1, 'desc.mipLevelCount: 1');
         if (this._draw_fb === undefined) {
            if (this.tex.swap_chain) {
               this._draw_fb = null;
            } else {
               this._draw_fb = gl.createFramebuffer();
               gl.bindFramebuffer(GL.DRAW_FRAMEBUFFER, this._draw_fb);
               this._framebuffer_attach(GL.DRAW_FRAMEBUFFER, GL.COLOR_ATTACHMENT0);
            }
         }
         gl.bindFramebuffer(GL.DRAW_FRAMEBUFFER, this._draw_fb);
      }
   }

   // -----

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

   const TEX_FORMAT_INFO = {
      /* Normal 8 bit formats */
      'r8unorm'             : {format: GL.R8                , unpack_format: GL.RED            , type: GL.UNSIGNED_BYTE               , float: true },
      'r8snorm'             : {format: GL.R8_SNORM          , unpack_format: GL.RED            , type: GL.BYTE                        , float: true },
      'r8uint'              : {format: GL.R8UI              , unpack_format: GL.RED            , type: GL.UNSIGNED_BYTE               , float: false},
      'r8sint'              : {format: GL.R8I               , unpack_format: GL.RED            , type: GL.BYTE                        , float: false},
      /* Normal 16 bit formats */
    //'r16unorm'            : {format: GL.R16               , unpack_format: GL.RED            , type: GL.UNSIGNED_SHORT              , float: true },
    //'r16snorm'            : {format: GL.R16_SNORM         , unpack_format: GL.RED            , type: GL.UNSIGNED_SHORT              , float: true },
      'r16uint'             : {format: GL.R16UI             , unpack_format: GL.RED            , type: GL.UNSIGNED_SHORT              , float: false},
      'r16sint'             : {format: GL.R16I              , unpack_format: GL.RED            , type: GL.SHORT                       , float: false},
      'r16float'            : {format: GL.R16F              , unpack_format: GL.RED            , type: GL.HALF_FLOAT                  , float: true },
      'rg8unorm'            : {format: GL.RG8               , unpack_format: GL.RG             , type: GL.UNSIGNED_BYTE               , float: true },
      'rg8snorm'            : {format: GL.RG8_SNORM         , unpack_format: GL.RG             , type: GL.BYTE                        , float: true },
      'rg8uint'             : {format: GL.RG8UI             , unpack_format: GL.RG             , type: GL.UNSIGNED_BYTE               , float: false},
      'rg8sint'             : {format: GL.RG8I              , unpack_format: GL.RG             , type: GL.BYTE                        , float: false},
      /* Packed 16 bit formats */
      'b5g6r5unorm'         : {format: GL.RGB565            , unpack_format: GL.RGB            , type: GL.UNSIGNED_SHORT_5_6_5        , float: true },
      /* Normal 32 bit formats */
      'r32uint'             : {format: GL.R32UI             , unpack_format: GL.RED            , type: GL.UNSIGNED_INT                , float: false},
      'r32sint'             : {format: GL.R32I              , unpack_format: GL.RED            , type: GL.INT                         , float: false},
      'r32float'            : {format: GL.R32F              , unpack_format: GL.RED            , type: GL.FLOAT                       , float: true },
    //'rg16unorm'           : {format: GL.RG16              , unpack_format: GL.RG             , type: GL.UNSIGNED_SHORT              , float: true },
    //'rg16snorm'           : {format: GL.RG16_SNORM        , unpack_format: GL.RG             , type: GL.SHORT                       , float: true },
      'rg16uint'            : {format: GL.RG16UI            , unpack_format: GL.RG             , type: GL.UNSIGNED_SHORT              , float: false},
      'rg16sint'            : {format: GL.RG16I             , unpack_format: GL.RG             , type: GL.SHORT                       , float: false},
      'rg16float'           : {format: GL.RG16F             , unpack_format: GL.RG             , type: GL.HALF_FLOAT                  , float: true },
      'rgba8unorm'          : {format: GL.RGBA8             , unpack_format: GL.RGBA           , type: GL.UNSIGNED_BYTE               , float: true },
      'rgba8unorm-srgb'     : {format: GL.SRGB8_ALPHA8      , unpack_format: GL.RGBA           , type: GL.UNSIGNED_BYTE               , float: true },
      'rgba8snorm'          : {format: GL.RGBA8_SNORM       , unpack_format: GL.RGBA           , type: GL.BYTE                        , float: true },
      'rgba8uint'           : {format: GL.RGBA8UI           , unpack_format: GL.RGBA           , type: GL.UNSIGNED_BYTE               , float: false},
      'rgba8sint'           : {format: GL.RGBA8I            , unpack_format: GL.RGBA           , type: GL.BYTE                        , float: false},
      'bgra8unorm'          : {format: GL.RGBA8             , unpack_format: GL.RGBA           , type: GL.UNSIGNED_BYTE               , float: true },
      'bgra8unorm-srgb'     : {format: GL.SRGB8_ALPHA8      , unpack_format: GL.RGBA           , type: GL.UNSIGNED_BYTE               , float: true },
      /* Packed 32 bit formats */
      'rgb10a2unorm'        : {format: GL.RGB10_A2          , unpack_format: GL.RGBA           , type: GL.UNSIGNED_INT_2_10_10_10_REV , float: true },
      'rg11b10float'        : {format: GL.R11F_G11F_B10F    , unpack_format: GL.RGB            , type: GL.UNSIGNED_INT_10F_11F_11F_REV, float: true },
      /* Normal 64 bit formats */
      'rg32uint'            : {format: GL.RG32UI            , unpack_format: GL.RG             , type: GL.UNSIGNED_INT                , float: false},
      'rg32sint'            : {format: GL.RG32I             , unpack_format: GL.RG             , type: GL.INT                         , float: false},
      'rg32float'           : {format: GL.RG32F             , unpack_format: GL.RG             , type: GL.FLOAT                       , float: true },
    //'rgba16unorm'         : {format: GL.RGBA16            , unpack_format: GL.RGBA           , type: GL.UNSIGNED_SHORT              , float: true },
    //'rgba16snorm'         : {format: GL.RGBA16_SNORM      , unpack_format: GL.RGBA           , type: GL.SHORT                       , float: true },
      'rgba16uint'          : {format: GL.RGBA16UI          , unpack_format: GL.RGBA           , type: GL.UNSIGNED_SHORT              , float: false},
      'rgba16sint'          : {format: GL.RGBA16I           , unpack_format: GL.RGBA           , type: GL.SHORT                       , float: false},
      'rgba16float'         : {format: GL.RGBA16F           , unpack_format: GL.RGBA           , type: GL.HALF_FLOAT                  , float: true },
      /* Normal 128 bit formats */
      'rgba32uint'          : {format: GL.RGBA32UI          , unpack_format: GL.RGBA           , type: GL.UNSIGNED_INT                , float: false},
      'rgba32sint'          : {format: GL.RGBA32I           , unpack_format: GL.RGBA           , type: GL.INT                         , float: false},
      'rgba32float'         : {format: GL.RGBA32F           , unpack_format: GL.RGBA           , type: GL.FLOAT                       , float: true },
      /* Depth/stencil formats */
      'depth32float'        : {format: GL.DEPTH_COMPONENT32F, unpack_format: GL.DEPTH_COMPONENT, type: GL.FLOAT                       , float: true },
      'depth24plus'         : {format: GL.DEPTH_COMPONENT24 , unpack_format: GL.DEPTH_COMPONENT, type: GL.UNSIGNED_INT                , float: true },
      'depth24plus-stencil8': {format: GL.DEPTH24_STENCIL8  , unpack_format: GL.DEPTH_STENCIL  , type: GL.UNSIGNED_INT_24_8           , float: true },
   };

   const DEFAULT_RENDERABLE = Object.fromEntries([
      'R8',
      'RG8',
      'RGB8',
      'RGB565',
      'RGBA4',
      'RGB5_A1',
      'RGBA8',
      'RGB10_A2',
      'RGB10_A2UI',
      'SRGB8_ALPHA8',
      'R8I',
      'R8UI',
      'R16I',
      'R16UI',
      'R32I',
      'R32UI',
      'RG8I',
      'RG8UI',
      'RG16I',
      'RG16UI',
      'RG32I',
      'RG32UI',
      'RGBA8I',
      'RGBA8UI',
      'RGBA16I',
      'RGBA16UI',
      'RGBA32I',
      'RGBA32UI',
   ].map(x => [GL[x], true]));
   const FLOAT_RENDERABLE = Object.fromEntries([
      'R16F',
      'R32F',
      'RG16F',
      'RG32F',
      'RGBA16F',
      'RGBA32F',
      'R11F_G11F_B10F',
   ].map(x => [GL[x], true]));

   const DEPTH_STENCIL_FORMAT = {
      'depth32float': {depth: true},
      'depth24plus': {depth: true},
      'depth24plus-stencil8': {depth: true, stencil: true},
   };

   class GPUTexture_JS {
      constructor(device, desc, swap_chain) {
         this.device = device;
         if (!desc)
            return;
         desc = make_GPUTextureDescriptor(desc);
         this.desc = desc;
         this.swap_chain = swap_chain;
         desc.format_info = TEX_FORMAT_INFO[desc.format];
         VALIDATE(desc.format_info, 'Unsupported: GPUTextureFormat ' + desc.format);

         if (desc.usage & (GPUTextureUsage.COPY_SRC | GPUTextureUsage.OUTPUT_ATTACHMENT)) {
            let renderable = DEFAULT_RENDERABLE[desc.format_info.format];
            if (!renderable) {
               renderable = FLOAT_RENDERABLE[desc.format_info.format];
               if (renderable) {
                  const gl = device.gl;
                  const ext = gl.getExtension('EXT_color_buffer_float');
                  ASSERT(ext,
                         'EXT_color_buffer_float required for GPUTextureUsage.[COPY_SRC,OUTPUT_ATTACHMENT] with ' + desc.format);
               }
            }
            ASSERT(renderable,
                   'Unsupported: GPUTextureUsage.[COPY_SRC,OUTPUT_ATTACHMENT] with ' + desc.format);
         }

         ASSERT(desc.sampleCount == 1, 'desc.sampleCount >1 not supported.');
         if (desc.dimension == '1d') {
            desc.size.height = 1;
            desc.size.depth = 1;
            desc.size.arrayLayerCount = 1;
         } else if (desc.dimension == '2d') {
            desc.size.depth = 1;
         } else {
            desc.size.arrayLayerCount = 1;
         }

         const ds_info = DEPTH_STENCIL_FORMAT[desc.format];
         if (ds_info) {
            this._depth = ds_info.depth;
            this._stencil = ds_info.stencil;
         }

         if (!this.swap_chain) {
            this._ensure_tex();
         }
      }

      _ensure_tex(dim) {
         if (this._gl_obj) {
            ASSERT(dim == this._gl_obj.dim,
            'GPUTextureViewDimension conversion not supported: ' + dim + '->' + this._gl_obj.dim);
         } else {
            if (!dim) {
               // Guess!
               if (this.desc.dimension == '1d') {
                  dim = '2d';
               } else if (this.desc.dimension == '3d') {
                  dim = '3d';
               } else if (this.desc.arrayLayerCount == 6 &&
                          this.desc.usage & GPUTextureUsage.SAMPLED) {
                  dim = 'cube'; // A Good Guess. :)
               } else if (this.desc.arrayLayerCount > 1) {
                  dim = '2d-array';
               } else {
                  dim = '2d';
               }
            }

            const desc = this.desc;
            const gl = this.device.gl;
            const tex = gl.createTexture();
            this._gl_obj = tex;
            tex.dim = dim;
            tex.format = TEX_FORMAT_INFO[this.desc.format].format;

            function bind_into(target) {
               tex.target = target;
               gl.bindTexture(target, tex);
            }

            if (dim == '3d') {
               bind_into(GL.TEXTURE_3D);
               gl.texStorage3D(tex.target, desc.mipLevelCount, tex.format, desc.size.width,
                               desc.size.height, desc.size.depth);
            } else if (dim == 'cube') {
               bind_into(GL.TEXTURE_CUBE_MAP);
               gl.texStorage2D(tex.target, desc.mipLevelCount, tex.format, desc.size.width,
                               desc.size.height);
            } else if (dim == '2d-array') {
               bind_into(GL.TEXTURE_2D_ARRAY);
               gl.texStorage3D(tex.target, desc.mipLevelCount, tex.format, desc.size.width,
                               desc.size.height, desc.arrayLayerCount);
            } else {
               bind_into(GL.TEXTURE_2D);
               gl.texStorage2D(tex.target, desc.mipLevelCount, tex.format, desc.size.width,
                               desc.size.height);
            }
         }
         return this._gl_obj;
      }

      createView(desc) {
         try {
            VALIDATE(!this.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');
            REQUIRE_NON_NULL(desc, 'GPUTextureView');
            return new GPUTextureView_JS(this, desc);
         } catch (e) {
            this.device._catch(e);
            return new GPUTextureView_JS(this, null);
         }
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
            VALIDATE(!this.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');
            const gl = this.device.gl;
            gl.deleteTexture(this._gl_obj);
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

         this._sparse_binding_layouts = [];
         for (const binding_layout of desc.bindings) {
            VALIDATE(this._sparse_binding_layouts[binding_layout.binding] === undefined,
                     'Duplicate binding layout location.');
            this._sparse_binding_layouts[binding_layout.binding] = binding_layout;
         }
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
         multisample: false,
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
         let bindingCount = 0;
         desc.bindGroupLayouts.forEach(x => {
            x._bindingOffset = bindingCount;
            bindingCount += x.desc.bindings.length;
         });
      }
   }

   function make_GPUPipelineLayoutDescriptor(desc) {
      desc = Object.assign({
      }, desc);
      REQUIRE_SEQ(desc, 'GPUPipelineLayoutDescriptor', 'bindGroupLayouts', GPUBindGroupLayout_JS);
      return desc;
   }

   // -

   class GPUBindGroup_JS {
      constructor(device, desc) {
         this.device = device;
         if (!desc)
            return;
         desc = make_GPUBindGroupDescriptor(desc);
         this.desc = desc;

         const used_bindings = {};
         for (const binding of desc.bindings) {
            VALIDATE(!used_bindings[binding.binding], 'Duplicate binding location.');
            used_bindings[binding.binding] = true;

            const layout = desc.layout._sparse_binding_layouts[binding.binding];
            VALIDATE(layout, 'Binding location has no BindGroupLayout entry.');

            if (binding.resource.sampler) {
               VALIDATE(layout.type == 'sampler', 'GPUSampler must be bound to GPUBindingType sampler');

            } else if (binding.resource.texture_view) {
               const types = ['sampled-texture', 'storage-texture'];
               VALIDATE(types.includes(layout.type), 'GPUTextureView must be bound to GPUBindingType ' + types.join('/'));
               VALIDATE(layout.textureDimension == binding.resource.texture_view.desc.dimension,
                        'Bad GPUBindGroupLayoutBinding.textureDimension for given GPUTextureView.');
               VALIDATE(layout.multisample == (binding.resource.texture_view.tex.desc.sampleCount != 1),
                        'Bad GPUBindGroupLayoutBinding.multisample for given GPUTextureView.');

            } else if (binding.resource.buffer_binding) {
               const types = ['uniform-buffer', 'storage-buffer', 'readonly-storage-buffer'];
               VALIDATE(types.includes(layout.type), 'GPUBufferBinding must be bound to GPUBindingType ' + types.join('/'));
               const cur = binding.resource.buffer_binding;
               VALIDATE(cur.buffer.desc.usage & GPUBufferUsage.UNIFORM,
                        'GPUBufferBinding.buffer must have GPUBufferUsage.UNIFORM.');

            } else {
               ASSERT(false, 'Bad GPUBindingResource type.');
            }
            binding._layout = layout;
         }
      }
   }

   function make_GPUBindGroupDescriptor(desc) {
      desc = Object.assign({
      }, desc);
      REQUIRE(desc, 'GPUBindGroupDescriptor', 'layout', GPUBindGroupLayout_JS);
      REQUIRE_SEQ(desc, 'GPUBindGroupDescriptor', 'bindings', null, make_GPUBindGroupBinding);
      return desc;
   }
   function make_GPUBindGroupBinding(desc) {
      desc = Object.assign({
      }, desc);
      REQUIRE(desc, 'GPUBindGroupBinding', 'binding');
      REQUIRE(desc, 'GPUBindGroupBinding', 'resource', null, make_GPUBindingResource);
      return desc;
   }
   function make_GPUBindingResource(cur) {
      if (cur instanceof GPUSampler_JS)
         return {sampler: cur};
      if (cur instanceof GPUTextureView_JS)
         return {texture_view: cur};

      desc = Object.assign({
         offset: 0,
      }, cur);
      REQUIRE(desc, 'GPUBufferBinding', 'buffer', GPUBuffer_JS);
      return {buffer_binding: desc};
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

   const SAMPLER_INFO_BY_TYPE = {};
   SAMPLER_INFO_BY_TYPE[GL.SAMPLER_2D                   ] = {dim: '2d'      , type: 'f', shadow: false};
   SAMPLER_INFO_BY_TYPE[GL.SAMPLER_2D_SHADOW            ] = {dim: '2d'      , type: 'f', shadow: true };
   SAMPLER_INFO_BY_TYPE[GL.SAMPLER_3D                   ] = {dim: '3d'      , type: 'f', shadow: false};
   SAMPLER_INFO_BY_TYPE[GL.SAMPLER_CUBE                 ] = {dim: 'cube'    , type: 'f', shadow: false};
   SAMPLER_INFO_BY_TYPE[GL.SAMPLER_CUBE_SHADOW          ] = {dim: 'cube'    , type: 'f', shadow: true };
   SAMPLER_INFO_BY_TYPE[GL.SAMPLER_2D_ARRAY             ] = {dim: '2d-array', type: 'f', shadow: false};
   SAMPLER_INFO_BY_TYPE[GL.SAMPLER_2D_ARRAY_SHADOW      ] = {dim: '2d-array', type: 'f', shadow: true };
   SAMPLER_INFO_BY_TYPE[GL.INT_SAMPLER_2D               ] = {dim: '2d'      , type: 'i', shadow: false};
   SAMPLER_INFO_BY_TYPE[GL.INT_SAMPLER_3D               ] = {dim: '3d'      , type: 'i', shadow: false};
   SAMPLER_INFO_BY_TYPE[GL.INT_SAMPLER_CUBE             ] = {dim: 'cube'    , type: 'i', shadow: false};
   SAMPLER_INFO_BY_TYPE[GL.INT_SAMPLER_2D_ARRAY         ] = {dim: '2d-array', type: 'i', shadow: false};
   SAMPLER_INFO_BY_TYPE[GL.UNSIGNED_INT_SAMPLER_2D      ] = {dim: '2d'      , type: 'u', shadow: false};
   SAMPLER_INFO_BY_TYPE[GL.UNSIGNED_INT_SAMPLER_3D      ] = {dim: '3d'      , type: 'u', shadow: false};
   SAMPLER_INFO_BY_TYPE[GL.UNSIGNED_INT_SAMPLER_CUBE    ] = {dim: 'cube'    , type: 'u', shadow: false};
   SAMPLER_INFO_BY_TYPE[GL.UNSIGNED_INT_SAMPLER_2D_ARRAY] = {dim: '2d-array', type: 'u', shadow: false};

   const RE_BINDING_PREFIX = /webgpu_group([0-9]+)_binding([0-9]+)_*(.*)/;


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
                  const gl_buf = gpu_buf ? gpu_buf._gl_obj : null;
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
         // `layout(binding=N) uniform` only added in ESSL310 :(

         function parse_binding(name, kind) {
            const match = name.match(RE_BINDING_PREFIX);
            VALIDATE(match,
                     name + ': GLSL uniform ' + kind + ' binding must start with /webgpu_group[0-9]+_binding[0-9]+_*/');
            return {
               group: parseInt(match[1]),
               binding: parseInt(match[2]),
            };
         }

         const prog_was = gl.getParameter(gl.CURRENT_PROGRAM);
         gl.useProgram(prog);
         try {
            const au_count = gl.getProgramParameter(prog, GL.ACTIVE_UNIFORMS);
            const au_ids = new Array(au_count).fill(1).map((x,i) => i);
            const au_types = gl.getActiveUniforms(prog, au_ids, GL.UNIFORM_TYPE);
            const au_block = gl.getActiveUniforms(prog, au_ids, GL.UNIFORM_BLOCK_INDEX);

            const validated_blocks = {};
            const used_locations = {};
            au_ids.forEach(active_id => {
               const block_id = au_block[active_id];
               if (block_id != -1) {
                  if (validated_blocks[block_id])
                     return;

                  const name = gl.getActiveUniformBlockName(prog, block_id);
                  const loc = parse_binding(name, 'block');
                  const loc_str = loc.group + ',' + loc.binding;
                  VALIDATE(!used_locations[loc_str],
                           name + ': Location already in use: ' + loc_str);
                  used_locations[loc_str] = name;

                  const bg_layout = desc.layout.desc.bindGroupLayouts[loc.group];
                  VALIDATE(bg_layout, name + ': No corresponding GPUBindGroupLayout');

                  const binding_info = bg_layout.desc.bindings[loc.binding];
                  VALIDATE(binding_info, name + ': No corresponding GPUBindGroupLayoutBinding');
                  const types = ['uniform-buffer' , 'storage-buffer', 'readonly-storage-buffer'];
                  VALIDATE(types.includes(binding_info.type),
                           name + ': GLSL uniform block requires GPUBindingType ' + types.join('/'));

                  const gl_binding = bg_layout._bindingOffset + loc.binding;
                  gl.uniformBlockBinding(prog, block_id, gl_binding);
                  validated_blocks[block_id] = true;

                  //const req_size = gl.getActiveUniformBlockParameter(prog, block_id, GL.UNIFORM_BLOCK_DATA_SIZE);
                  //console.log(name + ': req_size: ' + req_size);
                  return;
               }
               // Default-block uniforms:

               const info = gl.getActiveUniform(prog, active_id);
               const name = info.name;
               const sampler_info = SAMPLER_INFO_BY_TYPE[info.type];
               VALIDATE(sampler_info, name + ': GLSL non-sampler uniforms must be within a uniform block');

               // -

               const t_loc = parse_binding(name, 'sampler');
               const s_loc = Object.assign({}, t_loc);
               s_loc.binding += 1;

               const t_name = name + ' (texture)';
               const s_name = name + ' (sampler)';

               const t_loc_str = t_loc.group + ',' + t_loc.binding;
               const s_loc_str = s_loc.group + ',' + s_loc.binding;

               VALIDATE(!used_locations[t_loc_str],
                        t_name + ': Binding is already in use: ' + used_locations[t_loc_str]);
               VALIDATE(!used_locations[s_loc_str],
                        s_name + ': Binding is already in use: ' + used_locations[s_loc_str]);
               used_locations[t_loc_str] = t_name;
               used_locations[s_loc_str] = s_name;

               // -

               const bg_layout = desc.layout.desc.bindGroupLayouts[t_loc.group];
               VALIDATE(bg_layout, name + ': No corresponding GPUBindGroupLayout');

               const t_binding_info = bg_layout.desc.bindings[t_loc.binding];
               VALIDATE(t_binding_info,
                        t_name + ': No corresponding GPUBindGroupLayoutBinding for binding ' + t_loc_str);
               VALIDATE(t_binding_info.type == 'sampled-texture',
                        t_name + ': GLSL sampler requires layout GPUBindingType "sampled-texture" for binding ' + t_loc_str);
               VALIDATE(sampler_info.dim == t_binding_info.textureDimension,
                        t_name + ': GLSL sampler dimensions must match GPUBindGroupLayout.textureDimension for binding ' + t_loc_str);

               const s_binding_info = bg_layout.desc.bindings[s_loc.binding];
               VALIDATE(s_binding_info,
                        s_name + ': No corresponding GPUBindGroupLayout for binding ' + s_loc_str);
               VALIDATE(s_binding_info.type == 'sampler',
                        s_name + ': GLSL sampler requires layout GPUBindingType "sampler" for binding ' + s_loc_str);

               const gl_binding = bg_layout._bindingOffset + t_loc.binding;
               const gl_loc = gl.getUniformLocation(prog, name);
               gl.uniform1i(gl_loc, gl_binding);
            });
         } finally {
            gl.useProgram(prog_was);
         }

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

      _setup(fb, color_attachments, ds_attach_desc) {
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
               if (fb) {
                  draw_bufs.push(GL.COLOR_ATTACHMENT0 + i);
               } else {
                  draw_bufs.push(GL.BACK);
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
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');
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

         const attachment = desc.depthStencilAttachment || desc.colorAttachments[0];
         VALIDATE(attachment, 'Must have at least one color or depthStencil attachment.');
         const size = attachment.attachment.tex.desc.size;

         const device = cmd_enc.device;
         const gl = device.gl;

         // -

         let direct_backbuffer_bypass = (desc.colorAttachments.length == 1 &&
                                         desc.colorAttachments[0].attachment.tex.swap_chain &&
                                         !desc.colorAttachments[0].resolveTarget);
         const ds_desc = desc.depthStencilAttachment;
         if (ds_desc) {
            if (ds_desc.attachment._depth) {
               direct_backbuffer_bypass &= (ds_desc.depthLoadOp != 'load' &&
                                            ds_desc.depthStoreOp != 'store');
            }
            if (ds_desc.attachment._stencil) {
               direct_backbuffer_bypass &= (ds_desc.stencilLoadOp != 'load' &&
                                            ds_desc.stencilStoreOp != 'store');
            }
         }
         //direct_backbuffer_bypass = false;

         this.fb = null;
         if (!direct_backbuffer_bypass) {
            // Guess not!
            this.fb = gl.createFramebuffer();
         }

         // -

         function validate_view(name, view, for_depth_stencil) {
            VALIDATE(view.desc.arrayLayerCount == 1, name + ': Must have arrayLayerCount=1.');
            VALIDATE(view.desc.mipLevelCount == 1, name + ': Must have mipLevelCount=1.');
            VALIDATE(view.tex.desc.size.width == size.width &&
                     view.tex.desc.size.height == size.height, name + ': Sizes must match.');
            if (for_depth_stencil) {
               VALIDATE(view._depth || view._stencil, name + ': Must have depth or stencil.');
            } else {
               VALIDATE(!view._depth && !view._stencil, name + ': Must not have depth or stencil.');
            }
         }

         // -

         desc.colorAttachments.forEach((x, i) => {
            const view = x.attachment;
            const tex = view.tex;
            validate_view('colorAttachments[].attachment', view, false);

            if (this.fb) {
               if (tex.swap_chain) {
                  // Bad news...
                  console.error('SwapChain Texture attached, but didn\'t qualify for direct_backbuffer_bypass.');
               }
               gl.bindFramebuffer(GL.FRAMEBUFFER, this.fb);
               view._framebuffer_attach(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0 + i);
            }

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
                  fn_clear.call(gl, GL.COLOR, i, color);
               };
            } else {
               x._load_op = () => {};
            }

            if (x.resolveTarget) {
               validate_view('colorAttachments[].resolveTarget', x.resolveTarget, false);
               x.resolveTarget._bind_as_draw_fb(); // Ensure created.
            }

            x._store_op = () => {
               let read_attach_enum = GL.COLOR_ATTACHMENT0 + i;
               if (!this.fb) {
                  read_attach_enum = GL.COLOR;
               }

               function blit() {
                  gl.readBuffer(read_attach_enum);
                  const w = size.width;
                  const h = size.height;
                  gl.blitFramebuffer(0,0, w,h, 0,0, w,h, GL.COLOR_BUFFER_BIT, GL.NEAREST);
               }

               let discard = true;
               if (x.resolveTarget) {
                  x.resolveTarget._bind_as_draw_fb();
                  blit();
               } else if (x.storeOp == 'store') {
                  if (this.fb && tex.swap_chain) {
                     gl.bindFramebuffer(GL.DRAW_FRAMEBUFFER, null);
                     blit();
                  } else {
                     discard = false;
                  }
               }
               if (discard) {
                  gl.invalidateFramebuffer(GL.READ_FRAMEBUFFER, [read_attach_enum]);
               }
            };
         });

         // -

         if (ds_desc) {
            const view = ds_desc.attachment;
            validate_view('depthStencilAttachment.attachment', view, true);

            if (this.fb) {
               gl.bindFramebuffer(GL.FRAMEBUFFER, this.fb);
               if (view._depth) {
                  view._framebuffer_attach(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT);
               }
               if (view._stencil) {
                  view._framebuffer_attach(GL.FRAMEBUFFER, GL.STENCIL_ATTACHMENT);
               }
            }

            let did_load = false;
            ds_desc._load_op = () => {
               if (did_load)
                  return;
               did_load = true;
               const clear_depth = (view._depth && ds_desc.depthLoadOp == 'clear');
               const clear_stencil = (view._stencil && ds_desc.stencilLoadOp == 'clear');
               if (clear_depth) {
                  gl.depthMask(true);
                  if (!clear_stencil) {
                     gl.clearBufferfv(GL.DEPTH, 0, [ds_desc.clearDepth]);
                  }
               }
               if (clear_stencil) {
                  gl.stencilMask(0xffffffff);
                  if (clear_depth) {
                     gl.clearBufferfi(GL.DEPTH_STENCIL, 0, ds_desc.clearDepth, ds_desc.clearStencil);
                  } else {
                     gl.clearBufferiv(GL.STENCIL, 0, [ds_desc.clearStencil]);
                  }
               }
            };
            ds_desc._store_op = () => {
               let keep_depth = (view._depth && ds_desc.depthStoreOp == 'store');
               let keep_stencil = (view._stencil && ds_desc.stencilStoreOp == 'store');

               let depth_enum = GL.DEPTH_ATTACHMENT;
               let stencil_enum = GL.STENCIL_ATTACHMENT;
               if (!this.fb) {
                  depth_enum = GL.DEPTH;
                  stencil_enum = GL.STENCIL;
               }
               let discard_list = [];
               if (!keep_depth) {
                  discard_list.push(depth_enum);
               }
               if (!keep_stencil) {
                  discard_list.push(stencil_enum);
               }
               if (discard_list.length) {
                  gl.invalidateFramebuffer(GL.READ_FRAMEBUFFER, discard_list);
               }
            };
         }

         // -

         this.cmd_enc._add(() => {
            gl.bindFramebuffer(GL.FRAMEBUFFER, this.fb);
         });

         this._vert_buf_list = [];
         this._bind_group_list = [];
         this._deferred_bind_group_updates = [];

         this.setBlendColor([1, 1, 1, 1]);
         this.setStencilReference(0);
         this.setViewport(0, 0, size.width, size.height, 0, 1);
         this.setScissorRect(0, 0, size.width, size.height);
         this.setIndexBuffer(0, [], []);
         this.setVertexBuffers(0, [], []);
      }

      setBindGroup(index, bind_group, dynamic_offset_list) {
         try {
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');

            dynamic_offset_list = (dynamic_offset_list || []).slice();

            this._deferred_bind_group_updates[index] = {
               bind_group,
               dynamic_offset_list,
            };
         } catch (e) { this.cmd_enc.device._catch(e); }
      }

      setPipeline(pipeline) {
         try {
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');

            this._pipeline = pipeline;
            this._pipeline_ready = false;
            this._vert_bufs_ready = false;
            this._stencil_ref_ready = false;

         } catch (e) { this.cmd_enc.device._catch(e); }
      }
      setBlendColor(color) {
         try {
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');

            color = make_GPUColor(color);
            const gl = this.cmd_enc.device.gl;

            this.cmd_enc._add(() => {
               gl.blendColor(color.r, color.g, color.b, color.a);
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }
      setStencilReference(ref) {
         try {
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');

            this._stencil_ref = ref;
            this._stencil_ref_ready = false;

         } catch (e) { this.cmd_enc.device._catch(e); }
      }

      setViewport(x, y, w, h, min_depth, max_depth) {
         try {
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');

            const gl = this.cmd_enc.device.gl;

            this.cmd_enc._add(() => {
               gl.viewport(x, y, w, h);
               gl.depthRange(min_depth, max_depth);
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }

      setScissorRect(x, y, w, h) {
         try {
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');

            const gl = this.cmd_enc.device.gl;

            this.cmd_enc._add(() => {
               gl.scissor(x, y, w, h);
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }

      setIndexBuffer(buffer, offset) {
         try {
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');

            this._index_buf_offset = offset;
            const gl = this.cmd_enc.device.gl;
            const gl_buf = buffer ? buffer._gl_obj : null;

            this.cmd_enc._add(() => {
               gl.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, gl_buf);
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }
      setVertexBuffers(start_slot, buffers, offsets) {
         try {
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');

            for (let i in buffers) {
               i |= 0; // Arr ids are strings! 0 + '0' is '00'!
               const slot = start_slot + i;
               this._vert_buf_list[slot] = [buffers[i], offsets[i]];
            }
            this._vert_bufs_ready = false;

         } catch (e) { this.cmd_enc.device._catch(e); }
      }

      _pre_draw() {
         const gl = this.cmd_enc.device.gl;
         const pipeline = this._pipeline;
         if (!this._pipeline_ready) {
            this.cmd_enc._add(() => {
               // Generally speaking, don't use `this.foo` in _add, but rather use copies.
               // Exception: Immutable objects:
               pipeline._setup(this.fb, this.desc.colorAttachments, this.desc.depthStencilAttachment);
            });
            this._pipeline_ready = true;
         }
         if (!this._vert_bufs_ready) {
            const cur_buf_list = this._vert_buf_list.slice(); // Make a copy to embed.
            this.cmd_enc._add(() => {
               pipeline._set_vert_buffers(cur_buf_list);
            });
            this._vert_bufs_ready = true;
         }
         if (!this._stencil_ref_ready) {
            const cup_stencil_ref = this._stencil_ref;
            this.cmd_enc._add(() => {
               pipeline._set_stencil_ref(cup_stencil_ref);
            });
            this._stencil_ref_ready = true;
         }
         const pipeline_bg_layouts = pipeline.desc.layout.desc.bindGroupLayouts;
         if (this._deferred_bind_group_updates.length) {
            this._deferred_bind_group_updates.forEach((update, i) => {
               //console.log('def', update, i);
               const bg_layout = pipeline_bg_layouts[i];
               if (!bg_layout)
                  return;
               //console.log('bg_layout', bg_layout);
               this._deferred_bind_group_updates[i] = undefined;

               for (const cur of update.bind_group.desc.bindings) {
                  let loc = bg_layout._bindingOffset + cur.binding;
                  //console.log(cur, loc);
                  const res = cur.resource;

                  if (res.sampler) {
                     loc -= 1; // GPUSamplers are implied just after their sampled-textures.
                     this.cmd_enc._add(() => {
                        //console.log('bindSampler', loc, res.sampler._gl_obj);
                        gl.bindSampler(loc, res.sampler._gl_obj);
                     });
                     continue;
                  }

                  if (res.texture_view) {
                     this.cmd_enc._add(() => {
                        //console.log('activeTexture', loc);
                        gl.activeTexture(GL.TEXTURE0 + loc);
                        res.texture_view._bind_texture();
                     });
                     continue;
                  }

                  const buf = res.buffer_binding.buffer;
                  let offset = res.buffer_binding.offset;
                  let size = res.buffer_binding.size;

                  if (cur._layout.dynamic) {
                     VALIDATE(update.dynamic_offset_list.length, 'Not enough dynamic offsets');
                     offset += update.dynamic_offset_list.shift();
                  }

                  if (!size) {
                     size = buf.desc.size - offset;
                  }
                  this.cmd_enc._add(() => {
                     //console.log('bindBufferRange', loc, buf._gl_obj, offset, size);
                     gl.bindBufferRange(GL.UNIFORM_BUFFER, loc, buf._gl_obj, offset, size);
                  });
               }
            });
            while (this._deferred_bind_group_updates.length) {
               const last = this._deferred_bind_group_updates[this._deferred_bind_group_updates.length-1];
               if (last)
                  break;
               this._deferred_bind_group_updates.pop();
            }
         }
      }

      draw(vert_count, inst_count, base_vert, base_inst) {
         try {
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(base_inst == 0, 'firstInstance must be 0');

            this._pre_draw();

            const gl = this.cmd_enc.device.gl;
            const prim_topo = PRIM_TOPO[this._pipeline.desc.primitiveTopology];

            this.cmd_enc._add(() => {
               gl.drawArraysInstanced(prim_topo, base_vert, vert_count, inst_count);
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }
      drawIndexed(index_count, inst_count, base_index, base_vert, base_inst) {
         try {
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(base_inst == 0, 'firstInstance must be 0');

            this._pre_draw();

            const gl = this.cmd_enc.device.gl;
            const prim_topo = PRIM_TOPO[this._pipeline.desc.primitiveTopology];
            const format = INDEX_FORMAT[this._pipeline.desc.vertexInput.indexFormat];
            const offset = this._index_buf_offset + base_index * format.size;

            this.cmd_enc._add(() => {
               gl.drawElementsInstanced(prim_topo, index_count, format.type, offset, inst_count);
            });
         } catch (e) { this.cmd_enc.device._catch(e); }
      }

      endPass() {
         try {
            VALIDATE(!this.cmd_enc.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');
            this.cmd_enc._add(() => {
               for (const x of this.desc.colorAttachments) {
                  x._load_op(); // In case it was never otherwise used.
                  x._store_op();
               }
               const ds_desc = this.desc.depthStencilAttachment;
               if (ds_desc) {
                  ds_desc._load_op();
                  ds_desc._store_op();
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
            VALIDATE(!this.device._is_lost, 'Device is lost.');
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

      copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
         try {
            VALIDATE(!this.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(!this.in_pass, 'Cannot be within pass.');
            VALIDATE(!this.is_finished, 'Already finished.');

            VALIDATE(source.device == this.device &&
                     source.desc &&
                     !source._mapped() &&
                     source.desc.usage & GPUBufferUsage.COPY_SRC, 'Invalid source object.');
            VALIDATE(destination.device == this.device &&
                     destination.desc &&
                     !destination._mapped() &&
                     destination.desc.usage & GPUBufferUsage.COPY_DST, 'Invalid destination object.');

            const gl = this.device.gl;
            gl.bindBuffer(GL.COPY_READ_BUFFER, source._gl_obj);
            gl.bindBuffer(GL.COPY_WRITE_BUFFER, destination._gl_obj);
            gl.copyBufferSubData(GL.COPY_READ_BUFFER, GL.COPY_WRITE_BUFFER, sourceOffset, destinationOffset, size);
            gl.bindBuffer(GL.COPY_READ_BUFFER, null);
            gl.bindBuffer(GL.COPY_WRITE_BUFFER, null);
         } catch (e) { this.device._catch(e); }
      }

      copyBufferToTexture(src, dest, size) {
         try {
            VALIDATE(!this.device._is_lost, 'Device is lost.');
            VALIDATE(this.desc, 'Invalid object.');
            VALIDATE(!this.in_pass, 'Cannot be within pass.');
            VALIDATE(!this.is_finished, 'Already finished.');

            src = make_GPUBufferCopyView(src);
            dest = make_GPUTextureCopyView(dest);
            size = make_GPUExtent3D(size);

            VALIDATE(src.buffer.device == this.device &&
                     src.buffer.desc &&
                     !src.buffer._mapped() &&
                     src.buffer.desc.usage & GPUBufferUsage.COPY_SRC, 'Invalid source object.');
            VALIDATE(dest.texture.device == this.device &&
                     dest.texture.desc &&
                     dest.texture.desc.usage & GPUTextureUsage.COPY_DST, 'Invalid destination object.');

            const format = TEX_FORMAT_INFO[dest.texture.desc.format];

            const gl = this.device.gl;
            gl.bindBuffer(GL.PIXEL_UNPACK_BUFFER, src.buffer._gl_obj);
            const dst_target = dest.texture._gl_obj.target;
            gl.bindTexture(dst_target, dest.texture._gl_obj);
            if (dst_target == GL.TEXTURE_3D) {
               gl.texSubImage3D(dst_target, dest.mipLevel,  dest.origin.x, dest.origin.y, dest.origin.z,
                                size.width, size.height, size.depth,
                                format.unpack_format, format.type, src.offset);
            } else if (dst_target == GL.TEXTURE_2D_ARRAY) {
               gl.texSubImage3D(dst_target, dest.mipLevel, dest.origin.x, dest.origin.y, dest.arrayLayer,
                                size.width, size.height, 1,
                                format.unpack_format, format.type, src.offset);
            } else if (dst_target == GL.TEXTURE_CUBE_MAP) {
               // Cubemaps are the wooorst.
               gl.texSubImage2D(dst_target, dest.mipLevel, dest.origin.x, dest.origin.y,
                                size.width, size.height,
                                format.unpack_format, format.type, src.offset);
            } else {
               gl.texSubImage2D(dst_target, dest.mipLevel, dest.origin.x, dest.origin.y,
                                size.width, size.height,
                                format.unpack_format, format.type, src.offset);
            }
            gl.bindTexture(dst_target, null);
            gl.bindBuffer(GL.PIXEL_UNPACK_BUFFER, null);
         } catch (e) { this.device._catch(e); }
      }

      finish() {
         try {
            VALIDATE(!this.device._is_lost, 'Device is lost.');
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

   function make_GPUBufferCopyView(desc) {
      desc = Object.assign({
         offset: 0,
      }, desc);
      REQUIRE(desc, 'GPUBufferCopyView ', 'buffer', GPUBuffer_JS);
      REQUIRE(desc, 'GPUBufferCopyView ', 'rowPitch');
      REQUIRE(desc, 'GPUBufferCopyView ', 'imageHeight');
      return desc;
   }
   function make_GPUTextureCopyView(desc) {
      desc = Object.assign({
         mipLevel: 0,
         arrayLayer: 0,
         origin: [0, 0, 0],
      }, desc);
      REQUIRE(desc, 'GPUTextureCopyView ', 'texture', GPUTexture_JS);
      desc.origin = make_GPUOrigin3D(desc.origin);
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
            VALIDATE(!this.device._is_lost, 'Device is lost.');
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
         this._lost_promise = new Promise((yes, no) => {
            this._resolve_lost = yes;
         });

         this._queue = new GPUQueue_JS(this);
         this._error_scopes = [];
      }

      get adapter() { return this._adapter; }
      get extensions() { return this.gl_info.extensions; }
      get limits() { return this.gl_info.limits; }
      get lost() { return this._lost_promise; }

      _lose_gl() {
         const gl = this.gl;
         const ext = gl.getExtension('WEBGL_lose_context');
         ext.loseContext();
         ASSERT(gl.getError() == GL.CONTEXT_LOST_WEBGL, 'First CONTEXT_LOST_WEBGL.');
         ASSERT(!gl.getError(), 'Then NO_ERROR.');
      }

      lose() {
         console.error('GPUDevice lost!');
         this.desc = null;
         this._is_lost = true;
         this._resolve_lost();
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
               return null;
            }
            this._gl.canvas.addEventListener('webglcontextlost', (e) => {
               e.preventDefault();
               this.lose();
            });
         }
         return this._gl;
      }

      get gl() {
         return this._ensure_gl();
      }

      // -

      createBuffer(desc) {
         try {
            VALIDATE(!this._is_lost, 'Device is lost.');
            REQUIRE_NON_NULL(desc, 'GPUBufferDescriptor');
            return new GPUBuffer_JS(this, desc, false);
         } catch (e) {
            this._catch(e);
            return new GPUBuffer_JS(this, null);
         }
      }
      createBufferMapped(desc) {
         try {
            VALIDATE(!this._is_lost, 'Device is lost.');
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
            VALIDATE(!this._is_lost, 'Device is lost.');
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
            VALIDATE(!this._is_lost, 'Device is lost.');
            REQUIRE_NON_NULL(desc, 'GPUTextureDescriptor');
            return new GPUTexture_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPUTexture_JS(this, null);
         }
      }
      createSampler(desc) {
         try {
            VALIDATE(!this._is_lost, 'Device is lost.');
            return new GPUSampler_JS(this, desc || {});
         } catch (e) {
            this._catch(e);
            return new GPUSampler_JS(this, null);
         }
      }

      createBindGroupLayout(desc) {
         try {
            VALIDATE(!this._is_lost, 'Device is lost.');
            REQUIRE_NON_NULL(desc, 'GPUBindGroupLayoutDescriptor');
            return new GPUBindGroupLayout_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPUBindGroupLayout_JS(this, null);
         }
      }
      createPipelineLayout(desc) {
         try {
            VALIDATE(!this._is_lost, 'Device is lost.');
            REQUIRE_NON_NULL(desc, 'GPUPipelineLayoutDescriptor');
            return new GPUPipelineLayout_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPUPipelineLayout_JS(this, null);
         }
      }
      createBindGroup(desc) {
         try {
            VALIDATE(!this._is_lost, 'Device is lost.');
            REQUIRE_NON_NULL(desc, 'GPUBindGroupDescriptor');
            return new GPUBindGroup_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPUBindGroup_JS(this, null);
         }
      }

      createShaderModule(desc) {
         try {
            VALIDATE(!this._is_lost, 'Device is lost.');
            REQUIRE_NON_NULL(desc, 'GPUShaderModuleDescriptor');
            return new GPUShaderModule_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPUShaderModule_JS(this, null);
         }
      }
      createRenderPipeline(desc) {
         try {
            VALIDATE(!this._is_lost, 'Device is lost.');
            REQUIRE_NON_NULL(desc, 'GPURenderPipelineDescriptor');
            return new GPURenderPipeline_JS(this, desc);
         } catch (e) {
            this._catch(e);
            return new GPURenderPipeline_JS(this, null);
         }
      }

      createCommandEncoder(desc) {
         try {
            VALIDATE(!this._is_lost, 'Device is lost.');
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
