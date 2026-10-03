/*
 * src/leaflet.easyvelocity.js — the L.easyVelocity layer (entry point; load this file LAST)
 * ==============================================================================
 *
 * Applications normally load the single built file instead, dist/leaflet.easyvelocity.js, which is
 * these src/ files joined in the order below (see tools/build-dist.js).
 *
 *   const wind = L.easyVelocity({ source: "test" }).addTo(map);
 *   const wind = L.easyVelocity({ source: "https://.../gfs.t00z.pgrb2.0p25.f000" }).addTo(map);
 *
 * leaflet.easyvelocity is a Leaflet plugin that draws wind as a coloured speed field plus animated
 * particles, on its own <canvas> elements (it does not use Leaflet's SVG/Canvas renderers,
 * so the host map's `preferCanvas` setting makes no difference).
 *
 * THE FILES, in load order (see examples/index.html), and how they relate
 * -----------------------------------------------------------------------
 *  DATA SIDE: getting wind numbers. No Leaflet, no drawing. Could run in a Web Worker.
 *    src/grib2-unpack.js   decodes GRIB2 packed numbers (bit reader, packing formulas)
 *    src/grib2-reader.js   walks a GRIB2 message, reads its metadata, calls the unpacker
 *    src/wind-data.js      WindData: the wind grid + "what is the wind at lat/lon?"
 *    src/test-field.js     a synthetic WindData for development ("test" source)
 *    src/grib-loader.js    URL -> WindData (index + Range requests, or streaming)
 *    src/time-sources.js   list of (time, source) pairs -> times + timeSource for a time slider
 *    src/gfs.js            NOAA GFS / GEFS URL and forecast-time helpers
 *
 *  LAYER SIDE: drawing. Mixins that become methods of the layer defined in THIS file.
 *    src/frame-cache.js    loading + caching one WindData per time step, setTime()
 *    src/speed-field.js    colour scale, the on-screen wind grid, painting the speed field
 *    src/particles.js      the animated particles
 *
 *  OPTIONAL:
 *    src/time-dimension.js glue to the Leaflet.TimeDimension slider / player
 *
 *  THIS FILE: the Leaflet layer itself: options, the public API, how the canvases are placed
 *  on the map, and how they follow panning, zooming and resizing.
 *
 * The two halves only meet through WindData: the layer never sees GRIB, and the loaders never
 * see the map. To support a new data format, write a loader that returns a WindData.
 *
 * HOW THE LAYER STAYS ALIGNED WITH THE MAP
 * ----------------------------------------
 * Leaflet keeps all layers inside "panes" (divs). While you drag the map, Leaflet moves the
 * whole pane, so anything inside it moves for free. Our two canvases live in a pane too and are
 * a bit LARGER than the visible map (option `padding`), so a bit of extra map can be dragged
 * into view before we have to redraw. When the movement ENDS (moveend) we re-centre the canvases
 * on the new view and re-sample the wind (speed-field.js). During a zoom animation Leaflet
 * scales the canvases with a CSS transform (_updateTransform), then we redraw at the new zoom.
 */
(function (root) {
    "use strict";

    const L = root.L;
    const parts = root.EasyVelocityParts;

    // ---- friendly error if a script tag is missing or in the wrong order ----
    if (!L || !L.Layer) {
        throw new Error("leaflet.easyvelocity: Leaflet (global L) must be loaded before leaflet.easyvelocity.js.");
    }
    const required = {
        "src/grib2-unpack.js": "unpack", "src/grib2-reader.js": "grib2", "src/wind-data.js": "WindData",
        "src/test-field.js": "createTestField", "src/grib-loader.js": "loadSource", "src/time-sources.js": "timeList",
        "src/gfs.js": "gfsUrl",
        "src/frame-cache.js": "frameLoading", "src/speed-field.js": "speedField", "src/particles.js": "particles",
        "src/time-dimension.js": "installTimeDimension"
    };
    const missing = Object.keys(required).filter((file) => !parts || !parts[required[file]]);
    if (missing.length) {
        throw new Error("leaflet.easyvelocity: these scripts are missing or loaded after leaflet.easyvelocity.js: " + missing.join(", "));
    }

    const EasyVelocity = L.Layer.extend({

        // The mixins add: start/stop (particles), reload/setSource/setTime/... (frame-cache),
        // getLegend and the field painting (speed-field).
        includes: [parts.frameLoading, parts.speedField, parts.particles],

        options: {
            // ---- data ----
            source: "test",            // "test" | a GRIB2 URL | a WindData object
            timeSource: null,          // optional: (timeMs) => source. Gives each time its own file; overrides `source`
            cacheFrames: 6,            // how many decoded time steps to keep in memory
            level: 10,                 // which wind to use: 10 = 10 m above ground (for levelType 100: hPa, e.g. 850)
            levelType: 103,            // GRIB2 level type: 103 = metres above ground, 100 = pressure level
            fetchOptions: {},          // extra fetch() options for the streaming download

            // ---- particles ----
            particleCount: 4000,
            particleSpeed: 1.0,        // speed multiplier
            particleSize: 1,           // line width in CSS pixels
            particleOpacity: 0.8,
            particleColor: "#ffffff",
            particleMaxAge: 100,       // lifetime in animation frames
            trailLength: 0.9,          // 0..1: fraction of a trail kept each frame (higher = longer trails)
            showParticles: true,

            // ---- speed field ----
            showSpeedField: true,
            opacity: 0.75,             // opacity of the colour field
            colorScale: null,          // [[speed m/s, cssColor], ...]; null = default (see speed-field.js)

            // ---- behaviour ----
            pane: "overlayPane",       // Leaflet pane the canvases are placed in
            autoStart: true,           // start animating as soon as the layer is on the map
            padding: 0.25,             // canvas extends this fraction beyond the viewport on every side
            fieldResolution: 4,        // CSS pixels between wind samples of the screen grid
            pixelRatio: 1              // canvas pixels per CSS pixel (2 = sharper on retina, 4x the work)
        },

        // Runs once when you call L.easyVelocity(...). Sets up the state the mixins use.
        initialize: function (options) {
            L.setOptions(this, options);
            if (!this.options.colorScale) this.options.colorScale = parts.defaultColorScale;

            // -- data / frame cache (frame-cache.js) --
            this._data = null;          // the WindData currently displayed
            this._status = "idle";      // "idle" | "loading" | "ready" | "error"
            this._error = null;
            this._frames = new Map();   // cache: key -> { promise, data, abort }
            this._time = null;          // current time in ms (set by setTime)
            this._t0 = null;            // first time shown; origin of the synthetic field's motion
            this._loadToken = 0;        // numbers load requests so stale ones can be ignored

            // -- screen grid (speed-field.js) --
            this._gridReady = false;
            this._rebuildHandle = 0;
            this._tmp = new Float32Array(2);   // scratch space for WindData.sample()

            // -- particles / animation (particles.js) --
            this._wantRunning = this.options.autoStart !== false;
            this._raf = 0;
            this._needRespawn = true;
            this._tick = this._tick.bind(this);   // so it can be handed to requestAnimationFrame

            this._buildLut();
            this._allocParticles();
        },

        // ---- public API (the rest comes from the mixins) ------------------

        /**
         * Change any option while the layer is running, e.g. wind.setOptions({ particleCount: 8000 }).
         * Only the parts that depend on the changed options are redone.
         */
        setOptions: function (opts) {
            const previous = L.extend({}, this.options);
            const sourceChanged = opts && (
                ("source" in opts && opts.source !== previous.source) ||
                ("timeSource" in opts && opts.timeSource !== previous.timeSource) ||
                ("level" in opts && opts.level !== previous.level) ||
                ("levelType" in opts && opts.levelType !== previous.levelType));

            L.setOptions(this, opts);
            const o = this.options;

            if (o.particleCount !== previous.particleCount) {
                this._allocParticles();
                if (this._gridReady) this._initParticles();
            }
            if (o.colorScale !== previous.colorScale) {
                this._buildLut();
                if (this._gridReady) this._drawField();
            }
            if (this._wrap) {
                this._applyVisibility();
                if (!o.showParticles && this._pctx) this._pctx.clearRect(0, 0, this._cw, this._ch);
                if (o.fieldResolution !== previous.fieldResolution ||
                    o.pixelRatio !== previous.pixelRatio ||
                    o.padding !== previous.padding) {
                    this._update();
                }
            }
            if (sourceChanged) {
                this._clearFrames();
                this._load();
            }
            return this;
        },

        getSource: function () { return this.options.source; },
        getStatus: function () { return this._status; },       // "idle" | "loading" | "ready" | "error"
        getError: function () { return this._error; },
        getData: function () { return this._data; },            // the WindData on screen

        /** Wind at a point from the cached data: { u, v, speed } or null if there is no data there. */
        getVector: function (lat, lon) {
            return this._data ? this._data.getVector(lat, lon) : null;
        },

        // ---- Leaflet layer lifecycle -------------------------------------

        /** Leaflet calls this to learn which map events the layer wants (and unsubscribes automatically on removal). */
        getEvents: function () {
            // Dragging needs no handler: the canvases sit in a map pane and move with it.
            const events = {
                viewreset: this._update,      // map was reset (e.g. after a zoom): reposition and redraw
                zoom: this._onZoom,           // during a zoom: scale the canvases to match
                moveend: this._update,        // movement finished: recentre the canvases
                resize: this._update          // map container changed size
            };
            if (this._zoomAnimated) events.zoomanim = this._onAnimZoom;   // animated zoom is starting
            return events;
        },

        /** Leaflet calls this when the layer is added to a map. Builds the canvases. */
        onAdd: function (map) {
            // A wrapper div positioned inside the map pane, holding the two canvases:
            //   _fieldCanvas     the colour field (underneath)
            //   _particleCanvas  the particles and trails (on top)
            const wrap = this._wrap = L.DomUtil.create(
                "div", "leaflet-easyvelocity-layer" + (this._zoomAnimated ? " leaflet-zoom-animated" : ""));
            wrap.style.position = "absolute";
            wrap.style.left = "0";
            wrap.style.top = "0";
            wrap.style.pointerEvents = "none";     // clicks and drags pass through to the map

            this._fieldCanvas = document.createElement("canvas");
            this._particleCanvas = document.createElement("canvas");
            for (const canvas of [this._fieldCanvas, this._particleCanvas]) {
                canvas.style.position = "absolute";
                canvas.style.left = "0";
                canvas.style.top = "0";
                wrap.appendChild(canvas);
            }
            this._fctx = this._fieldCanvas.getContext("2d");
            this._pctx = this._particleCanvas.getContext("2d");

            this._origin = null;
            this._zoom = null;
            this._cw = this._ch = 0;

            map.getPane(this.options.pane).appendChild(wrap);
            this._applyVisibility();
            this._update();

            if (!this._data && this._status !== "loading") this._load();   // first time on a map: get data
            this._schedule();                                                // start the animation loop
        },

        /** Leaflet calls this when the layer is removed from the map. The decoded data stays cached. */
        onRemove: function () {
            this._cancelFrame();
            if (this._rebuildHandle) {
                cancelAnimationFrame(this._rebuildHandle);
                this._rebuildHandle = 0;
            }
            L.DomUtil.remove(this._wrap);
            this._wrap = this._fieldCanvas = this._particleCanvas = this._fctx = this._pctx = null;
            this._gridReady = false;
        },

        // ---- keeping the canvases aligned with the map -------------------

        /**
         * (Re)size and (re)position the canvases so they cover the visible map plus `padding`,
         * then ask for the screen grid to be rebuilt. Runs on add, moveend, viewreset, resize.
         */
        _update: function () {
            if (!this._map || !this._wrap) return;
            const map = this._map;
            const padding = this.options.padding;
            const ratio = this._ratio = Math.max(0.5, this.options.pixelRatio || 1);

            // Canvas size = visible map size * (1 + 2 * padding); `min` = its top-left corner in
            // "layer points" (Leaflet's pixel coordinates inside the map panes).
            const mapSize = map.getSize();
            const min = map.containerPointToLayerPoint(mapSize.multiplyBy(-padding)).round();
            const cssSize = mapSize.multiplyBy(1 + padding * 2).round();
            const w = Math.max(1, Math.round(cssSize.x * ratio));
            const h = Math.max(1, Math.round(cssSize.y * ratio));
            const zoom = map.getZoom();

            if (this._origin && this._zoom === zoom && w === this._cw && h === this._ch) {
                // Only panned: keep each particle at the same GEOGRAPHIC spot. The canvas moved by
                // (previousOrigin - newOrigin) on screen, so shift the particles' canvas
                // coordinates by the same amount.
                const previous = map.latLngToLayerPoint(this._originLatLng);
                const dx = (previous.x - min.x) * ratio;
                const dy = (previous.y - min.y) * ratio;
                if (dx || dy) {
                    const px = this._px;
                    const py = this._py;
                    for (let i = 0; i < px.length; i++) {
                        px[i] += dx;
                        py[i] += dy;
                    }
                }
            } else {
                // Zoomed or resized: positions no longer mean anything, scatter new particles.
                this._needRespawn = true;
            }

            this._origin = min;
            this._originLatLng = map.layerPointToLatLng(min);   // remember it geographically for the next pan
            this._center = map.getCenter();
            this._zoom = zoom;

            for (const canvas of [this._fieldCanvas, this._particleCanvas]) {
                if (canvas.width !== w) canvas.width = w;       // (changing width also clears the canvas)
                if (canvas.height !== h) canvas.height = h;
                canvas.style.width = cssSize.x + "px";
                canvas.style.height = cssSize.y + "px";
            }
            this._cw = w;
            this._ch = h;
            this._pctx.clearRect(0, 0, w, h);                   // old trails no longer line up
            L.DomUtil.setPosition(this._wrap, min);             // this also removes any zoom transform
            this._invalidateField();
        },

        _onZoom: function () {
            this._updateTransform(this._map.getCenter(), this._map.getZoom());
        },

        _onAnimZoom: function (e) {
            this._updateTransform(e.center, e.zoom);
        },

        /**
         * During a zoom, stretch the existing canvases to look right until the zoom ends and we
         * redraw. Same maths as Leaflet's own canvas renderer: compute where the canvas will be
         * and how much it is scaled at the target zoom, and apply it as a CSS transform.
         */
        _updateTransform: function (center, zoom) {
            if (!this._wrap || !this._center) return;
            const map = this._map;
            const scale = map.getZoomScale(zoom, this._zoom);
            const viewHalf = map.getSize().multiplyBy(0.5 + this.options.padding);
            const currentCenterPoint = map.project(this._center, zoom);
            const offset = viewHalf.multiplyBy(-scale)
                .add(currentCenterPoint)
                .subtract(map._getNewPixelOrigin(center, zoom));    // (a private Leaflet method, as used by Leaflet itself)
            if (L.Browser.any3d) L.DomUtil.setTransform(this._wrap, offset, scale);
            else L.DomUtil.setPosition(this._wrap, offset);
        },

        /** Apply showSpeedField / showParticles / opacity to the canvases. */
        _applyVisibility: function () {
            this._fieldCanvas.style.display = this.options.showSpeedField ? "" : "none";
            this._fieldCanvas.style.opacity = String(this.options.opacity);
            this._particleCanvas.style.display = this.options.showParticles ? "" : "none";
        }
    });

    // ---- public exports ----------------------------------------------------

    L.EasyVelocity = EasyVelocity;
    L.easyVelocity = function (options) { return new EasyVelocity(options); };
    L.WindField = EasyVelocity;
    L.windField = L.easyVelocity;

    // Handy extras for application code and the demo page.
    L.easyVelocity.WindData = parts.WindData;
    L.easyVelocity.Grib2 = parts.grib2;
    L.easyVelocity.createTestField = parts.createTestField;
    L.easyVelocity.gfsUrl = parts.gfsUrl;
    L.easyVelocity.gfsForecast = parts.gfsForecast;
    L.easyVelocity.gfsAnalyses = parts.gfsAnalyses;
    L.easyVelocity.gefsMeanUrl = parts.gefsMeanUrl;
    L.easyVelocity.gefsMeanForecast = parts.gefsMeanForecast;
    L.easyVelocity.timeList = parts.timeList;
    L.easyVelocity.defaultColorScale = parts.defaultColorScale;
    L.easyVelocity.installTimeDimension = parts.installTimeDimension;

    L.windField.WindData = L.easyVelocity.WindData;
    L.windField.Grib2 = L.easyVelocity.Grib2;
    L.windField.createTestField = L.easyVelocity.createTestField;
    L.windField.gfsUrl = L.easyVelocity.gfsUrl;
    L.windField.gfsForecast = L.easyVelocity.gfsForecast;
    L.windField.gfsAnalyses = L.easyVelocity.gfsAnalyses;
    L.windField.gefsMeanUrl = L.easyVelocity.gefsMeanUrl;
    L.windField.gefsMeanForecast = L.easyVelocity.gefsMeanForecast;
    L.windField.timeList = L.easyVelocity.timeList;
    L.windField.defaultColorScale = L.easyVelocity.defaultColorScale;
    L.windField.installTimeDimension = L.easyVelocity.installTimeDimension;

    // If Leaflet.TimeDimension was loaded first, enable L.timeDimension.layer.easyVelocity(...).
    parts.installTimeDimension();
})(globalThis);
