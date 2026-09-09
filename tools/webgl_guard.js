/* Bedrock — make a lying WebGL context safe to hand to a library.
 *
 * THE DEFECT. Safari can return a WebGL context that is functionally lost
 * while reporting isContextLost() === false. getContext() succeeds, the
 * context looks live, and then every query the spec says returns an object
 * returns null instead — which the spec only permits WHEN THE CONTEXT IS LOST.
 *
 * Libraries dereference those returns immediately, because on a live context
 * they cannot be null. Measured on an iPhone, both from one defect:
 *
 *   three.js  getShaderPrecisionFormat(VERTEX_SHADER, HIGH_FLOAT).precision
 *   Cesium    getParameter(MAX_VIEWPORT_DIMS)[0]
 *
 * Patching each library's symptom fixes the same bug once per library and
 * waits to fix it again — getContextAttributes, getSupportedExtensions and
 * the other fixed-capability getParameter pnames are equally exposed.
 *
 * So this guards the CONTEXT, once, before any library touches it. Two parts:
 *
 *   harden()  answers the queries where null is never valid on a live context
 *             with what a compliant implementation returns. Deliberately NOT
 *             getExtension — null is a legitimate answer there.
 *
 *   trusted() asks a context whether it is telling the truth, so a caller can
 *             discard a liar and retry rather than let a library throw. This
 *             is what makes the NEXT null we have not seen yet survivable.
 *
 * Load before any WebGL library. A classic <script> runs before module code,
 * which is why this is not a module.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  /* Numeric constants rather than gl.NAME, so the table is built once instead
     of per call and needs no context to read it. Values are the spec's own
     required minimums: enough for a library to proceed, never a claim the
     hardware cannot meet. */
  var PARAM = {
    0x0D3A: function () { return new Int32Array([4096, 4096]); },  // MAX_VIEWPORT_DIMS
    0x846E: function () { return new Float32Array([1, 1]); },      // ALIASED_LINE_WIDTH_RANGE
    0x846D: function () { return new Float32Array([1, 1]); },      // ALIASED_POINT_SIZE_RANGE
    0x0D33: function () { return 4096; },                          // MAX_TEXTURE_SIZE
    0x851C: function () { return 4096; },                          // MAX_CUBE_MAP_TEXTURE_SIZE
    0x84E8: function () { return 4096; },                          // MAX_RENDERBUFFER_SIZE
    0x8869: function () { return 16; },                            // MAX_VERTEX_ATTRIBS
    0x8872: function () { return 8; },                             // MAX_TEXTURE_IMAGE_UNITS
    0x8B4D: function () { return 8; },                             // MAX_COMBINED_TEXTURE_IMAGE_UNITS
    0x8DFB: function () { return 128; },                           // MAX_VERTEX_UNIFORM_VECTORS
    0x8DFD: function () { return 16; },                            // MAX_FRAGMENT_UNIFORM_VECTORS
    0x8DFC: function () { return 8; },                             // MAX_VARYING_VECTORS
    0x1F00: function () { return 'unknown'; },                     // VENDOR
    0x1F01: function () { return 'unknown'; },                     // RENDERER
    0x1F02: function () { return 'WebGL 1.0'; },                   // VERSION
    0x8B8C: function () { return 'WebGL GLSL ES 1.0'; }            // SHADING_LANGUAGE_VERSION
  };

  var ATTRS = {
    alpha: true, antialias: false, depth: true, premultipliedAlpha: true,
    preserveDrawingBuffer: false, stencil: false, desynchronized: false,
    failIfMajorPerformanceCaveat: false, powerPreference: 'default'
  };

  var patched = 0;
  /* The unrepaired methods, kept so trusted() can ask the CONTEXT a question
     rather than ask the guard. Reading them off the prototype after hardening
     would call the repair and every context would look honest. */
  var RAW = {};

  function wrap(proto, name, repair) {
    var original = proto[name];
    if (!RAW[name] && original) RAW[name] = original;
    proto[name] = function () {
      var r = null;
      try { r = original ? original.apply(this, arguments) : null; } catch (e) { r = null; }
      if (r !== null && r !== undefined) return r;
      return repair.apply(this, arguments);
    };
  }

  function harden(Ctor) {
    var proto = Ctor && Ctor.prototype;
    if (!proto || proto.__bedrockGuarded) return;
    wrap(proto, 'getShaderPrecisionFormat',
         function () { return { rangeMin: 127, rangeMax: 127, precision: 23 }; });
    wrap(proto, 'getContextAttributes', function () { return ATTRS; });
    wrap(proto, 'getSupportedExtensions', function () { return []; });
    wrap(proto, 'getParameter', function (pname) {
      var f = PARAM[pname];
      return f ? f() : null;   // unknown pname: null was the honest answer
    });
    proto.__bedrockGuarded = true;
    patched++;
  }

  harden(window.WebGLRenderingContext);
  harden(window.WebGL2RenderingContext);

  /* Would this context lie to a library? Asked BEFORE the guard's repairs, so
     it reports the truth about the context rather than about the guard. */
  function trusted(gl) {
    if (!gl) return false;
    try {
      if (gl.isContextLost && gl.isContextLost()) return false;
      if (RAW.getParameter) {
        var dims = RAW.getParameter.call(gl, 0x0D3A);        // MAX_VIEWPORT_DIMS
        if (!dims || dims[0] === undefined || dims[0] <= 0) return false;
      }
      if (RAW.getShaderPrecisionFormat) {
        var pf = RAW.getShaderPrecisionFormat.call(gl, gl.VERTEX_SHADER, gl.HIGH_FLOAT);
        if (!pf) return false;
      }
    } catch (e) { return false; }
    return true;
  }

  window.__bedrockGL = {
    patched: patched,
    trusted: trusted,
    /* A context that has been asked whether it is telling the truth. Returns
       null rather than a liar, so the caller degrades on purpose instead of
       finding out through an exception three frames later. */
    context: function (canvas, attrs) {
      var gl = null;
      try { gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs); }
      catch (e) { return null; }
      return trusted(gl) ? gl : null;
    }
  };
})();
