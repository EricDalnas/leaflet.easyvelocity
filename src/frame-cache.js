/*
 * frame-cache.js — loading wind data, one "frame" per time step, with a cache
 * ============================================================================
 *
 * Part of leaflet.easyvelocity. This file is a MIXIN: a bundle of methods that leaflet.easyvelocity.js
 * mixes into the L.EasyVelocity layer (Leaflet's `includes` feature). Inside these methods
 * `this` is the layer. Needs grib-loader.js and wind-data.js.
 *
 * VOCABULARY
 *   frame      the wind data (a WindData) for ONE moment in time, like one frame of a film.
 *   time       milliseconds since 1970-01-01 UTC (what JavaScript's Date.getTime() returns).
 *   source     where a frame comes from: "test", a GRIB2 URL, or a ready-made WindData.
 *   timeSource an optional function (timeMs) => source, so each time can have its own file.
 *
 * WHY A CACHE?
 * Downloading and decoding a frame takes up to a second or more. A time slider or play
 * button flips between frames quickly, so we keep the last few decoded frames in memory
 * (option `cacheFrames`) and let callers prefetch the next ones:
 *
 *      slider moves to 06:00  ->  isTimeReady(06:00)?  ->  yes: show it immediately
 *                                                      ->  no:  prefetchTime(06:00), show when ready
 *
 * Panning and zooming the map NEVER touch this file: the wind data is cached, only the
 * on-screen sampling is redone (see speed-field.js).
 *
 * THE LIFE OF A REQUEST
 *   setTime(t) / setSource(s) / reload()
 *        |
 *        v
 *   _load()  ->  _frameEntry(t)  returns the cache entry for that source+time, creating it
 *        |                        (and starting the download) if it does not exist yet
 *        v
 *   when the data is there: this._data = the frame, fire "load", redraw the field
 *   if it fails:            fire "error"
 *
 * Events fired on the layer: "loading", "progress", "load", "error".
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    parts.frameLoading = {

        // ---- public API --------------------------------------------------

        /** Drop everything cached and load the current source again. */
        reload: function () {
            this._clearFrames();
            this._load();
            return this;
        },

        /** Switch to a different source (e.g. another GRIB2 URL). */
        setSource: function (source) {
            this.options.source = source;
            this._clearFrames();
            this._load();
            return this;
        },

        /**
         * Show the frame for `time` (milliseconds or a Date). Called by the TimeDimension
         * integration whenever the slider moves.
         * Does nothing for a single static source (a URL without a timeSource).
         * @returns {Promise<boolean>} resolves to true once the frame is displayed
         */
        setTime: function (time) {
            this._time = +time;
            if (this._t0 === null) this._t0 = this._time;   // remember the first time ever shown
            if (!this._isTimeDependent()) return Promise.resolve(false);
            // keepParticles: the particles keep flowing; only the wind they follow changes.
            return this._load({ keepParticles: true });
        },

        getTime: function () { return this._time; },

        /** Is the frame for `time` already downloaded and decoded? */
        isTimeReady: function (time) {
            if (!this._isTimeDependent()) return true;
            const entry = this._frames.get(this._frameKey(+time));
            return !!(entry && entry.data);
        },

        /** Start loading the frame for `time` into the cache without showing it. */
        prefetchTime: function (time) {
            if (!this._isTimeDependent()) return Promise.resolve(this._data);
            return this._frameEntry(+time).promise;
        },

        /** Called by the TimeDimension player: make room for the frames it plans to prefetch. */
        setMinimumForwardCache: function (n) {
            this.options.cacheFrames = Math.max(this.options.cacheFrames, n + 2);
        },

        // ---- which source / which cache entry ----------------------------

        // Does the data depend on the time? Only if a timeSource exists, or the built-in test field is used.
        _isTimeDependent: function () {
            return !!this.options.timeSource || this.options.source === "test";
        },

        // The source for a given time: from timeSource(time) if provided, else the plain `source` option.
        _sourceFor: function (time) {
            return this.options.timeSource ? this.options.timeSource(time) : this.options.source;
        },

        // Hours since the first time shown, at millisecond-rounded precision. The synthetic test
        // field uses this to move its weather systems.
        _hours: function (time) {
            return time == null || this._t0 === null ? 0 : Math.round((time - this._t0) / 3.6e3) / 1e3;
        },

        // Cache key. Two requests with the same key share one download.
        _frameKey: function (time) {
            const source = this._sourceFor(time);
            if (source === "test") return "test@" + this._hours(time);
            return source instanceof parts.WindData ? source : String(source);
        },

        // ---- the cache ---------------------------------------------------

        /**
         * Find or create the cache entry for `time`:
         *   { promise: resolves to the WindData, data: the WindData once loaded, abort: AbortController }
         * The Map keeps insertion order, and re-inserting on every use makes it an LRU
         * ("least recently used first") list, which _trimFrames relies on.
         */
        _frameEntry: function (time) {
            const key = this._frameKey(time);
            const existing = this._frames.get(key);
            if (existing) {
                this._frames.delete(key);
                this._frames.set(key, existing);   // mark as most recently used
                return existing;
            }

            const source = this._sourceFor(time);
            const o = this.options;
            const abortController = new AbortController();
            const entry = { data: null, abort: abortController, promise: null };

            entry.promise = parts.loadSource(source, {
                level: o.level,
                levelType: o.levelType,
                fetchOptions: o.fetchOptions,
                hours: this._hours(time),
                signal: abortController.signal,
                onProgress: (bytes) => this.fire("progress", { source, time, loaded: bytes })
            }).then((data) => {
                entry.data = data;
                return data;
            });

            // A failed load must not stay cached, otherwise it could never be retried.
            entry.promise.catch(() => {
                if (this._frames.get(key) === entry) this._frames.delete(key);
            });

            this._frames.set(key, entry);
            this._trimFrames();
            return entry;
        },

        // Evict the least recently used frames beyond `cacheFrames`, but never the one on screen.
        _trimFrames: function () {
            const max = Math.max(2, this.options.cacheFrames);
            for (const [key, entry] of this._frames) {
                if (this._frames.size <= max) break;
                if (entry.data && entry.data === this._data) continue;
                if (!entry.data) entry.abort.abort();        // still downloading: cancel it
                this._frames.delete(key);
            }
        },

        _clearFrames: function () {
            for (const entry of this._frames.values()) {
                if (!entry.data) entry.abort.abort();
            }
            this._frames.clear();
        },

        // ---- showing a frame ---------------------------------------------

        /**
         * Make the frame for the current time the one on screen.
         * @param {object} [opts]
         * @param {boolean} [opts.keepParticles]  if true, existing particles are kept (used while scrubbing time)
         * @returns {Promise<boolean>} true if this call's frame ended up displayed
         */
        _load: function (opts) {
            opts = opts || {};

            // With a timeSource we cannot know which file to fetch until setTime() has been called.
            if (this.options.timeSource && this._time === null) return Promise.resolve(false);

            // Each call gets a number. If the user scrubs quickly, a slow older load must not
            // overwrite a newer one when it finally completes: it checks its number first.
            const token = ++this._loadToken;
            const time = this._time;
            const source = this._sourceFor(time);
            const entry = this._frameEntry(time);

            const show = (data) => {
                const hadData = !!this._data;
                this._data = data;
                this._status = "ready";
                this._error = null;
                if (!(opts.keepParticles && hadData)) this._needRespawn = true;
                if (this._map) this._invalidateField();      // re-sample the new data onto the screen
                this.fire("load", { source, data, time });
            };

            // Already cached: show it right now (synchronously).
            if (entry.data) {
                show(entry.data);
                return Promise.resolve(true);
            }

            this._status = "loading";
            this._error = null;
            this.fire("loading", { source, time });

            return entry.promise.then((data) => {
                if (token !== this._loadToken) return false;   // superseded by a newer request
                show(data);
                return true;
            }).catch((err) => {
                if (token !== this._loadToken || parts.isAbortError(err)) return false;
                this._data = null;
                this._status = "error";
                this._error = err;
                if (this._map) this._invalidateField();
                this.fire("error", { source, time, error: err, message: err.message });
                return false;
            });
        }
    };
})(globalThis);
