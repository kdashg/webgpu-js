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

   GL_TEX_FORMAT = {
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

   // -

   function REQUIRE(dict, type, key, val_type) {
      const name = type + '.' + key;
      if (dict[key] === undefined) throw new Error(name + ' required.');
      if (val_type) {
         if (!(dict[key] instanceof val_type))
            throw new Error(name + ' must be `' + val_type + '`.');
      }
   }

   // -

   function make_GPUColor(dict) {
      if (dict.length) {
         if (dict.length != 4) throw new Error('`GPUColor.length` must be 4.');
         dict = {
            r: dict[0],
            g: dict[1],
            b: dict[2],
            a: dict[3],
         }
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
      return Object.assign({
         x: dict[0] || 0,
         y: dict[1] || 0,
      }, dict);
   }

   function make_GPUOrigin3D(dict) {
      return Object.assign({
         x: dict[0] || 0,
         y: dict[1] || 0,
         z: dict[2] || 0,
      }, dict);
   }

   function make_GPUExtent3D(dict) {
      if (dict.length) {
         if (dict.length != 3) throw new Error('`GPUExtent3D.length` must be 3.');
         dict = {
            width: dict[0],
            height: dict[1],
            depth: dict[2],
         }
      } else {
         REQUIRE(dict, 'GPUExtent3D', 'width');
         REQUIRE(dict, 'GPUExtent3D', 'height');
         REQUIRE(dict, 'GPUExtent3D', 'depth');
         dict = Object.assign({}, dict);
      }
      return dict;
   }

   // -

   function make_GPUTextureViewDescriptor(desc) {
      REQUIRE(desc, 'GPUTextureViewDescriptor', 'format');
      REQUIRE(desc, 'GPUTextureViewDescriptor', 'dimension');
      REQUIRE(desc, 'GPUTextureViewDescriptor', 'aspect');
      desc = Object.assign({
         baseMipLevel: 0,
         mipLevelCount: 1,
         baseArrayLayer: 0,
         arrayLayerCount: 1,
      }, desc);
      return desc;
   }

   class GpuJsTextureView {
      constructor(tex, desc) {
         this.tex = tex;
         this.desc = desc;
      }
   }

   // -

   function make_GPUTextureDescriptor(desc) {
      REQUIRE(desc, 'GPUTextureDescriptor', 'size');
      REQUIRE(desc, 'GPUTextureDescriptor', 'format');
      REQUIRE(desc, 'GPUTextureDescriptor', 'usage');
      desc = Object.assign({
         arrayLayerCount: 1,
         mipLevelCount: 1,
         sampleCount: 1,
         dimension: '2d',
      }, desc);
      desc.size = make_GPUExtent3D(desc.size);
      return desc;
   }

   class GpuJsTexture {
      constructor(dev, desc, swap_chain) {
         desc = make_GPUTextureDescriptor(desc);
         this.device = dev;
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
         return new GpuJsTextureView(this, make_GPUTextureViewDescriptor(desc));
      }

      createDefaultView() {
         return this.createView({
            format: this.desc.format,
            dimension: this.desc.dimension,
            aspect: 'all',
         });
      }

      destroy() {
         const gl = this.device.gl;
         gl.deleteTexture(this.tex);
      }
   }

   // -

   class GpuJsProgrammablePassEncoder {
      constructor(cmd_enc) {
         this.cmd_enc = cmd_enc;
      }

      endPass() {
         if (this.cmd_enc.in_pass == this) {
            this.cmd_enc.in_pass = null;
         }
      }
   }

   function make_GPURenderPassColorAttachmentDescriptor(desc) {
      REQUIRE(desc, 'GPURenderPassColorAttachmentDescriptor', 'attachment', GpuJsTextureView);
      REQUIRE(desc, 'GPURenderPassColorAttachmentDescriptor', 'loadOp');
      REQUIRE(desc, 'GPURenderPassColorAttachmentDescriptor', 'storeOp');
      desc = Object.assign({
         resolveTarget: null,
         clearColor: [0,0,0,1],
      }, desc);
      desc.clearColor = make_GPUColor(desc.clearColor);
      return desc;
   }

   function make_GPURenderPassDepthStencilAttachmentDescriptor(desc) {
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'attachment', GpuJsTextureView);
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'depthLoadOp');
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'depthStoreOp');
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'clearDepth');
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'stencilLoadOp');
      REQUIRE(desc, 'GPURenderPassDepthStencilAttachmentDescriptor ', 'stencilStoreOp');
      desc = Object.assign({
         clearStencil: 0,
      }, desc);
      return desc;
   }

   function make_GPURenderPassDescriptor(desc) {
      REQUIRE(desc, 'GPURenderPassDescriptor', 'colorAttachments');
      desc = Object.assign({
         depthStencilAttachment: null,
      }, desc);

      desc.colorAttachments = desc.colorAttachments.map(make_GPURenderPassColorAttachmentDescriptor);
      if (desc.depthStencilAttachment) {
         desc.depthStencilAttachment = make_GPURenderPassDepthStencilAttachmentDescriptor(desc.depthStencilAttachment);
      }
      return desc;
   }

   class GpuJsRenderPassEncoder extends GpuJsProgrammablePassEncoder {
      constructor(cmd_enc, desc) {
         super(cmd_enc);
         this.desc = desc;

         const gl = cmd_enc.device.gl;
         this.fb = null;
         if (desc.colorAttachments.length == 1 &&
            desc.colorAttachments[0].attachment.tex.swap_chain) {
         } else {
            this.fb = gl.createFramebuffer();
         }
         gl.bindFramebuffer(GL.FRAMEBUFFER, this.fb);

         const clears = [];

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
               clears.push(() => {
                  //console.log('clear', i, color);
                  fn_clear.call(gl, GL.COLOR, i, color);
               });
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

         this.cmd_enc._add(() => {
            gl.bindFramebuffer(GL.FRAMEBUFFER, this.fb);
            clears.forEach(x => {
               x();
            });
         });
      }
   }

   // -


   class GpuJsCommandBuffer {
      constructor(enc) {
         this.enc = enc;
      }
   }

   class GpuJsCommandEncoder {
      constructor(device) {
         this.device = device;
         this.in_pass = null;
         this.is_finished = false;
         this.cmds = [];
      }

      _assert() {
         if (this.in_pass) throw new Error('in_pass');
         if (this.is_finished) throw new Error('is_finished');
      }

      _add(fn_cmd) {
         this.cmds.push(fn_cmd);
      }

      beginRenderPass(desc) {
         this._assert();
         const ret = new GpuJsRenderPassEncoder(this, make_GPURenderPassDescriptor(desc));
         this.in_pass = ret;
         return ret;
      }

      finish() {
         this._assert();
         this.is_finished = true;
         return new GpuJsCommandBuffer(this);
      }
   }

   // -

   class GpuJsQueue {
      constructor(device) {
         this.device = device;
      }

      submit(buffers) {
         buffers.forEach(cmd_buf => {
            const cmds = cmd_buf.enc.cmds;
            cmds.forEach(x => {
               x();
            })
         });
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

   class GpuJsDeviceLostInfo {
      constructor(message) {
         this._message = message.slice();
      }

      get message() { return this._message; }
   }

   class GpuJsDevice {
      constructor() {
         this._gl = null;
         this.is_lost = false;
         this._lost = new Promise((yes, no) => {
            this.resolve_lost = () => {
               this.is_lost = true;
               yes();
            };
         });

         this._queue = new GpuJsQueue(this);
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


      createTexture(desc) {
         return new GpuJsTexture(this, desc);
      }

      createCommandEncoder(desc) {
         return new GpuJsCommandEncoder(this, desc)
      }

      getQueue() {
         return this._queue;
      }
   }


   class GpuJsApapter {
      constructor() {}

      get name() { return this.last_info.name; }
      get extensions() { return this.last_info.extensions; }

      requestDevice(desc) {
         desc = make_GPUDeviceDescriptor(desc);
         return new Promise((yes, no) => {
            if (!is_subset(desc.extensions, this.last_info.extensions))
               return no('`extensions` not a subset of adapters\'.');

            if (!is_subset(desc.limits, this.last_info.limits))
               return no('`limits` not a subset of adapters\'.');

            const ret = new GpuJsDevice();
            ret._adapter = this;
            ret.gl_info = this.last_info;
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

   class GpuJs {
      requestAdapter(desc) {
         desc = Object.assign({}, desc);
         if (!desc.powerPreference) {
            desc.powerPreference = 'default'; // map to webgl
         }

         return new Promise((yes, no) => {
            const ret = new GpuJsApapter();
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
      REQUIRE(desc, 'GPUSwapChainDescriptor', 'device', GpuJsDevice);
      REQUIRE(desc, 'GPUSwapChainDescriptor', 'format');
      desc = Object.assign({
         usage: GPUTextureUsage.OUTPUT_ATTACHMENT,
      }, desc);
      return desc;
   }

   class GpuJsSwapChain {
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
            this.tex = new GpuJsTexture(this.desc.device, desc, sc_if_fast);
         }
         return this.tex;
      }
   }

   // -

   class GpuJsCanvasContext {
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
            console.log('Slowpath: separate gl context for swap chain.');
            this.gl = desc.device.adapter.make_gl(this.canvas);
         }
         if (!this.gl)
            return null;

         this.swap_chain = new GpuJsSwapChain(this, desc);
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
         ret = new GpuJsCanvasContext(this);
         this._gpu_js = ret;
      }
      return ret;
   };

   return new GpuJs();
})();

if (!navigator.gpu) {
   navigator.gpu = navigator.gpu_js;
}
