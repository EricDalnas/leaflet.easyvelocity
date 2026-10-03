/*
 * speed-field.js — the coloured wind-speed background, and the screen-aligned wind grid
 * ======================================================================================
 *
 * Part of leaflet.easyvelocity. This file is a MIXIN for the L.EasyVelocity layer: its methods are
 * mixed in by leaflet.easyvelocity.js and `this` is the layer. Needs Leaflet.
 *
 * TWO COORDINATE WORLDS
 * ---------------------
 *   geographic   latitude/longitude. The WindData lives here.
 *   canvas       pixels of the layer's own <canvas>, origin at its top-left corner. Drawing,
 *                and the particles' positions, live here.
 *
 * Converting between them for every particle on every animation frame would be slow, so instead
 * we do it ONCE whenever the map view changes (_rebuildField):
 *
 *      for a coarse grid of canvas pixels (every `fieldResolution` px, default 4 px):
 *          convert the pixel to latitude/longitude        <- Leaflet does this
 *          ask WindData for the wind there                 <- bilinear interpolation
 *          store it in a small array (this._gu / this._gv, "u" and "v" per grid cell)
 *
 * The result is a "screen grid": a picture of the wind field in canvas pixels. Everything
 * after that is cheap:
 *   - the colour field is just that grid painted as an image (_drawField), and
 *   - each particle looks up its wind in the same grid (see particles.js).
 *
 * When does this run? On every moveend / zoom / resize / new data. NOT while dragging (the
 * canvas simply moves with the map pane), and never involving a download.
 *
 * COLOUR SCALE
 * ------------
 * `colorScale` is a list of [speed in m/s, CSS colour] stops. Speeds in between are blended
 * linearly. For speed we precompute a 256-entry lookup table (LUT) from slowest to fastest, so
 * painting a cell is one array lookup instead of colour maths.
 */
(function (root) {
    "use strict";

    const L = root.L;
    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    // Default scale in m/s: blue (calm) -> green -> yellow -> orange -> red -> purple (storm).
    parts.defaultColorScale = [
        [0, "#264b96"], [3, "#2f8ed1"], [6, "#2fc2a8"], [9, "#6fd05c"], [12, "#d3df3a"],
        [16, "#f7b52c"], [20, "#f26b21"], [25, "#d62839"], [32, "#8a1c7c"]
    ];

    /**
     * Turn [[value, cssColor], ...] into [{value, color, r, g, b}, ...] sorted by value.
     * The browser does the colour parsing for us: paint one pixel with the CSS colour on a
     * 1x1 canvas and read the red/green/blue back. That accepts "#abc", "rgb(...)", "red", ...
     */
    function parseColorStops(stops) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        return stops.map((stop) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = "#000";          // fallback if the CSS colour is invalid
            ctx.fillStyle = stop[1];
            ctx.fillRect(0, 0, 1, 1);
            const px = ctx.getImageData(0, 0, 1, 1).data;
            return { value: stop[0], color: stop[1], r: px[0], g: px[1], b: px[2] };
        }).sort((a, b) => a.value - b.value);
    }

    parts.speedField = {

        /** The colour scale, for building a legend: { units, min, max, stops: [{value, color}] }. */
        getLegend: function () {
            const stops = this._stops;
            return {
                units: "m/s",
                min: stops[0].value,
                max: stops[stops.length - 1].value,
                stops: stops.map((s) => ({ value: s.value, color: s.color }))
            };
        },

        /** Build the 256-colour lookup table from the `colorScale` option. */
        _buildLut: function () {
            const scale = this.options.colorScale && this.options.colorScale.length > 1
                ? this.options.colorScale
                : parts.defaultColorScale;
            const stops = this._stops = parseColorStops(scale);
            const min = this._lutMin = stops[0].value;
            const max = stops[stops.length - 1].value;
            this._lutScale = 255 / Math.max(1e-9, max - min);   // speed -> LUT index multiplier

            const lut = this._lut = new Uint8ClampedArray(256 * 3);   // r, g, b per entry
            let s = 0; // index of the stop at the lower end of the current segment
            for (let i = 0; i < 256; i++) {
                const speed = min + (i / 255) * (max - min);
                while (s < stops.length - 2 && speed > stops[s + 1].value) s++;
                const a = stops[s];
                const b = stops[s + 1];
                // How far between the two stops are we? 0..1
                const t = b.value === a.value ? 0 : Math.min(1, Math.max(0, (speed - a.value) / (b.value - a.value)));
                lut[i * 3] = a.r + (b.r - a.r) * t;
                lut[i * 3 + 1] = a.g + (b.g - a.g) * t;
                lut[i * 3 + 2] = a.b + (b.b - a.b) * t;
            }
        },

        /**
         * "The screen grid is out of date, rebuild it soon." Several events can arrive in one
         * burst (viewreset + moveend, ...), so the rebuild is scheduled for the next animation
         * frame and duplicates are ignored. Until then the particles pause (_gridReady = false).
         */
        _invalidateField: function () {
            this._gridReady = false;
            if (this._rebuildHandle) return;
            this._rebuildHandle = requestAnimationFrame(() => {
                this._rebuildHandle = 0;
                this._rebuildField();
            });
        },

        /**
         * Sample the cached WindData onto the screen grid (see the top of this file), then
         * repaint the colour field.
         *
         * Grid cell (i, j) corresponds to canvas pixel (i * cell, j * cell), where `cell` is
         * the resolution in canvas pixels. Its u/v end up in this._gu[j * gridWidth + i].
         */
        _rebuildField: function () {
            if (!this._map || !this._wrap) return;
            const canvasW = this._cw;
            const canvasH = this._ch;
            const data = this._data;

            if (!data) {
                // Nothing loaded (yet, or an error): show an empty layer.
                this._gridReady = false;
                this._fctx.clearRect(0, 0, canvasW, canvasH);
                this._pctx.clearRect(0, 0, canvasW, canvasH);
                return;
            }

            const ratio = this._ratio;                                        // canvas px per CSS px
            const cell = Math.max(1, this.options.fieldResolution) * ratio;    // grid spacing in canvas px
            const gridW = Math.ceil(canvasW / cell) + 1;                       // +1: a cell on each edge
            const gridH = Math.ceil(canvasH / cell) + 1;
            if (!this._gu || this._gu.length !== gridW * gridH) {
                this._gu = new Float32Array(gridW * gridH);
                this._gv = new Float32Array(gridW * gridH);
            }
            this._gw = gridW;
            this._gh = gridH;
            this._cell = cell;

            const gu = this._gu;
            const gv = this._gv;
            const tmp = this._tmp;
            const map = this._map;
            const origin = this._origin;     // where the canvas's top-left corner is, in Leaflet "layer points"
            const stepCss = cell / ratio;    // grid spacing in CSS pixels (Leaflet works in CSS pixels)

            // SPEED-UP for the standard map projection (Web Mercator, EPSG:3857): there, longitude
            // depends only on the x pixel and latitude only on the y pixel. So instead of one
            // conversion per grid cell we do one per column plus one per row.
            const separable = map.options.crs === L.CRS.EPSG3857;
            const lons = new Float64Array(gridW);
            const lats = new Float64Array(gridH);
            if (separable) {
                for (let i = 0; i < gridW; i++) {
                    lons[i] = map.layerPointToLatLng(L.point(origin.x + i * stepCss, origin.y)).lng;
                }
                for (let j = 0; j < gridH; j++) {
                    lats[j] = map.layerPointToLatLng(L.point(origin.x, origin.y + j * stepCss)).lat;
                }
            }

            for (let j = 0; j < gridH; j++) {
                for (let i = 0; i < gridW; i++) {
                    let lat, lon;
                    if (separable) {
                        lat = lats[j];
                        lon = lons[i];
                    } else {
                        // Other projections: convert every cell individually (slower but general).
                        const ll = map.layerPointToLatLng(L.point(origin.x + i * stepCss, origin.y + j * stepCss));
                        lat = ll.lat;
                        lon = ll.lng;
                    }
                    const k = j * gridW + i;
                    if (data.sample(lat, lon, tmp)) {
                        gu[k] = tmp[0];
                        gv[k] = tmp[1];
                    } else {
                        gu[k] = NaN;   // no data here (outside the grid, or a hole in it)
                        gv[k] = NaN;
                    }
                }
            }

            this._gridReady = true;
            this._drawField();
            if (this._needRespawn) this._initParticles();
        },

        /**
         * Paint the colour field.
         *
         * Trick: instead of colouring millions of canvas pixels, make a tiny image with ONE
         * pixel per screen-grid cell (a few hundred by a few hundred), colour those, and let the
         * browser stretch it over the canvas with smooth (bilinear) scaling. That gives a
         * continuous colour field for almost no CPU cost.
         */
        _drawField: function () {
            const gridW = this._gw;
            const gridH = this._gh;
            const gu = this._gu;
            const gv = this._gv;

            // A small off-screen canvas that holds the one-pixel-per-cell picture.
            if (!this._speedImg) this._speedImg = document.createElement("canvas");
            const small = this._speedImg;
            if (small.width !== gridW) small.width = gridW;
            if (small.height !== gridH) small.height = gridH;
            const smallCtx = small.getContext("2d");
            const image = smallCtx.createImageData(gridW, gridH);
            const rgba = image.data;                    // 4 bytes per pixel: red, green, blue, alpha

            const lut = this._lut;
            const lutMin = this._lutMin;
            const lutScale = this._lutScale;
            for (let k = 0, n = gridW * gridH; k < n; k++) {
                const u = gu[k];
                const v = gv[k];
                if (u !== u || v !== v) continue;       // NaN = no data: leave the pixel transparent
                const speed = Math.sqrt(u * u + v * v);
                let index = ((speed - lutMin) * lutScale) | 0;           // speed -> 0..255
                index = index < 0 ? 0 : index > 255 ? 255 : index;       // clamp
                const p = k * 4;
                const c = index * 3;
                rgba[p] = lut[c];
                rgba[p + 1] = lut[c + 1];
                rgba[p + 2] = lut[c + 2];
                rgba[p + 3] = 255;
            }
            smallCtx.putImageData(image, 0, 0);

            // Stretch it over the real canvas. Cell (i, j) is CENTRED on canvas pixel
            // (i * cell, j * cell), hence the half-cell shift.
            const ctx = this._fctx;
            const cell = this._cell;
            ctx.clearRect(0, 0, this._cw, this._ch);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(small, -cell / 2, -cell / 2, gridW * cell, gridH * cell);
        }
    };
})(globalThis);
