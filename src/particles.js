/*
 * particles.js — the animated flow particles
 * ===========================================
 *
 * Part of leaflet.easyvelocity. This file is a MIXIN for the L.EasyVelocity layer: its methods are
 * mixed in by leaflet.easyvelocity.js and `this` is the layer.
 *
 * HOW THE ANIMATION WORKS
 * -----------------------
 * Thousands of tiny "particles" are placed at random positions. Every animation frame
 * (about 60 times a second) each particle:
 *   1. looks up the velocity at its position in the screen grid built by speed-field.js,
 *   2. moves a little way in that direction,
 *   3. draws a short line from its old to its new position.
 * Lines from previous frames are faded out a little each frame instead of erased, which
 * produces the flowing "trails". After `particleMaxAge` frames a particle is reborn at a new
 * random position, so the picture stays evenly covered.
 *
 *      frame n                 frame n+1
 *        o  ->  flow  ->         o          the line drawn between the two positions is one
 *      (x, y)               (x + dx, y + dy)   small piece of a trail
 *
 * PERFORMANCE: thousands of particles, 60 frames a second, so
 *   - particle state lives in typed arrays (one Float32Array per coordinate), not objects:
 *     no allocation, no garbage collection in the loop;
 *   - ALL the line segments of a frame are added to ONE path and stroked with ONE call.
 *
 * PARTICLE STATE (arrays indexed by particle number i)
 *   _px[i], _py[i]   position in canvas pixels
 *   _age[i]          frames lived so far; -1 means "dormant": waiting for a place with data
 *   _maxAge[i]       lifetime in frames (randomised so they do not all die at once)
 *
 * FLOW DIRECTION ON SCREEN
 *   u (east)  increases x (moves right)
 *   v (north) DEcreases y (screen y grows downwards)       so:  dy = -v * scale
 *
 * MISSING DATA: if the velocity under a particle is NaN (outside the data, or a hole), the
 * particle becomes dormant, then respawns somewhere that has data. That is the
 * "disappears and reappears" behaviour.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    parts.particles = {

        // ---- start / stop -------------------------------------------------

        /** Start (or resume) the animation. Frozen frames keep their trails. */
        start: function () {
            this._wantRunning = true;
            this._schedule();
            this.fire("start");
            return this;
        },

        stop: function () {
            this._wantRunning = false;
            this._cancelFrame();
            this.fire("stop");
            return this;
        },

        isRunning: function () { return this._wantRunning; },

        // ---- setting particles up ----------------------------------------

        /** (Re)create the typed arrays for `particleCount` particles. */
        _allocParticles: function () {
            const n = Math.max(0, this.options.particleCount | 0);
            this._px = new Float32Array(n);
            this._py = new Float32Array(n);
            this._age = new Int16Array(n);
            this._maxAge = new Uint16Array(n);
            this._needRespawn = true;
        },

        /**
         * Put particle i at a random canvas position that has data.
         * Tries 8 random spots; if none has data the particle goes dormant (age = -1) and is
         * retried on the next frame.
         * @returns {boolean} true if it was placed
         */
        _spawn: function (i) {
            const canvasW = this._cw;
            const canvasH = this._ch;
            const gu = this._gu;
            const gridW = this._gw;
            const toGrid = 1 / this._cell;          // canvas pixels -> screen-grid cells

            for (let attempt = 0; attempt < 8; attempt++) {
                const x = Math.random() * (canvasW - 1);
                const y = Math.random() * (canvasH - 1);
                const gridIndex = Math.round(y * toGrid) * gridW + Math.round(x * toGrid);
                if (gu[gridIndex] === gu[gridIndex]) {          // not NaN: there is data here
                    this._px[i] = x;
                    this._py[i] = y;
                    this._age[i] = 0;
                    this._maxAge[i] = this.options.particleMaxAge * (0.6 + 0.8 * Math.random());
                    return true;
                }
            }
            this._age[i] = -1;
            return false;
        },

        /** Scatter all particles, with random ages so they do not all expire in the same frame. */
        _initParticles: function () {
            this._needRespawn = false;
            const n = this._px.length;
            for (let i = 0; i < n; i++) {
                if (this._spawn(i)) this._age[i] = (Math.random() * this._maxAge[i]) | 0;
            }
            if (this._pctx) this._pctx.clearRect(0, 0, this._cw, this._ch);
        },

        // ---- the animation loop ------------------------------------------

        _schedule: function () {
            if (this._map && this._wantRunning && !this._raf) {
                this._raf = requestAnimationFrame(this._tick);
            }
        },

        _cancelFrame: function () {
            if (this._raf) {
                cancelAnimationFrame(this._raf);
                this._raf = 0;
            }
        },

        // requestAnimationFrame calls this once per screen refresh (and pauses in hidden tabs).
        _tick: function () {
            this._raf = requestAnimationFrame(this._tick);
            this._step();
        },

        /** Advance every particle by one frame and draw it. */
        _step: function () {
            const o = this.options;
            if (!o.showParticles || !this._gridReady || !this._pctx) return;
            const ctx = this._pctx;

            // ---- 1. fade the previous frames (this makes the trails) ----
            // "destination-in" keeps the existing pixels but multiplies their opacity by the fill
            // colour's alpha. With trailLength 0.9, a pixel keeps 90% of its opacity per frame.
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "destination-in";
            ctx.fillStyle = "rgba(0,0,0," + Math.min(1, Math.max(0, o.trailLength)) + ")";
            ctx.fillRect(0, 0, this._cw, this._ch);

            // ---- 2. set up for drawing the new line segments ----
            ctx.globalCompositeOperation = "source-over";
            ctx.globalAlpha = o.particleOpacity;
            ctx.strokeStyle = o.particleColor;
            ctx.lineWidth = o.particleSize * this._ratio;
            ctx.beginPath();

            // Local copies: cheaper than looking up `this._x` thousands of times.
            const px = this._px;
            const py = this._py;
            const age = this._age;
            const maxAge = this._maxAge;
            const gu = this._gu;
            const gv = this._gv;
            const gridW = this._gw;
            const gridH = this._gh;
            const toGrid = 1 / this._cell;

            // Pixels moved per frame for 1 m/s of velocity. Deliberately independent of zoom, so the
            // motion looks the same at every zoom level (as on windy.com); particle density is
            // constant too, because the count is spread over the same screen-sized canvas.
            const pixelsPerMps = 0.15 * o.particleSpeed * this._ratio;

            // ---- 3. move every particle ----
            for (let i = 0, n = px.length; i < n; i++) {
                // Dormant or too old: try to place it somewhere new; skip it this frame if impossible.
                const a = age[i];
                if (a < 0 || a >= maxAge[i]) {
                    if (!this._spawn(i)) continue;
                }

                const x = px[i];
                const y = py[i];

                // Which screen-grid cell is the particle in, and where inside it?
                const gx = x * toGrid;
                const gy = y * toGrid;
                const ix = gx | 0;           // left cell index (fast floor for positive numbers)
                const iy = gy | 0;           // top cell index
                if (gx < 0 || gy < 0 || ix >= gridW - 1 || iy >= gridH - 1) {
                    age[i] = -1;             // left the canvas: respawn next frame
                    continue;
                }
                const fx = gx - ix;          // 0..1 across the cell
                const fy = gy - iy;          // 0..1 down the cell
                const b = iy * gridW + ix;   // index of the cell's top-left corner

                // Bilinear interpolation of the velocity from the 4 corners (the same idea as in
                // VelocityData.sample, see velocity-data.js).
                const u = (gu[b] * (1 - fx) + gu[b + 1] * fx) * (1 - fy) +
                    (gu[b + gridW] * (1 - fx) + gu[b + gridW + 1] * fx) * fy;
                const v = (gv[b] * (1 - fx) + gv[b + 1] * fx) * (1 - fy) +
                    (gv[b + gridW] * (1 - fx) + gv[b + gridW + 1] * fx) * fy;

                if (u !== u || v !== v) {    // NaN: entered an area without data
                    age[i] = -1;
                    continue;
                }

                // Move, and add one segment (old position -> new position) to the shared path.
                const nx = x + u * pixelsPerMps;
                const ny = y - v * pixelsPerMps;       // minus: screen y grows downwards
                ctx.moveTo(x, y);
                ctx.lineTo(nx, ny);
                px[i] = nx;
                py[i] = ny;
                age[i] = age[i] + 1;       // re-read: _spawn may have reset the age to 0 above
            }

            // ---- 4. draw all segments with a single call ----
            ctx.stroke();
        }
    };
})(globalThis);
