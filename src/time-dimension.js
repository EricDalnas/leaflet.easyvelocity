/*
 * time-dimension.js — optional glue to the Leaflet.TimeDimension slider / player
 * ===============================================================================
 *
 * Part of leaflet.easyvelocity. OPTIONAL: only does something if the Leaflet.TimeDimension plugin
 * (https://github.com/socib/Leaflet.TimeDimension) was loaded before leaflet.easyvelocity.js.
 *
 * WHAT TimeDimension GIVES YOU
 * A map option `timeDimension: true` creates `map.timeDimension`: a clock that knows a list of
 * available times and a current time. `timeDimensionControl: true` adds the slider with
 * play / step buttons. Layers that want to follow the clock "register" with it.
 *
 * THE PROTOCOL (how the clock and a layer talk)
 *   1. The user moves the slider to time T.
 *   2. The clock asks every registered layer: isReady(T)?
 *        - all ready      -> the clock switches to T at once and fires "timeload"
 *        - some not ready -> the clock fires "timeloading" {time: T}; each layer starts loading T
 *                            and fires "timeload" {time: T} on ITSELF when finished.
 *                            When every layer has answered, the clock switches to T.
 *   3. When the clock has switched, it fires "timeload"; layers update their display (`_update`).
 *   The player also announces upcoming times ("timeloading") so layers can prefetch them.
 *
 * Our wrapper layer translates that into the wind layer's own API:
 *   isReady(T)             ->  windLayer.isTimeReady(T)
 *   "timeloading" {T}      ->  windLayer.prefetchTime(T), then fire "timeload"
 *   switch to T (_update)  ->  windLayer.setTime(T)
 *
 * USAGE
 *   const wind = L.easyVelocity({ timeSource: (timeMs) => "https://.../file-for-that-time" });
 *   L.timeDimension.layer.easyVelocity(wind).addTo(map);     // NOT wind.addTo(map)
 */
(function (root) {
    "use strict";

    const L = root.L;
    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    /**
     * Defines L.TimeDimension.Layer.EasyVelocity and the factory L.timeDimension.layer.easyVelocity().
     * Called automatically by leaflet.easyvelocity.js. Safe to call again later (e.g. if the
     * TimeDimension plugin was loaded after this file). Returns false if it is not available.
     */
    parts.installTimeDimension = function installTimeDimension() {
        if (!L.TimeDimension || !L.TimeDimension.Layer || !L.timeDimension) return false;
        if (L.TimeDimension.Layer.EasyVelocity) {
            L.TimeDimension.Layer.WindField = L.TimeDimension.Layer.EasyVelocity;
            L.timeDimension.layer.windField = L.timeDimension.layer.easyVelocity;
            return true;
        }

        L.TimeDimension.Layer.EasyVelocity = L.TimeDimension.Layer.extend({

            // The clock wants time ev.time: load it into the cache, then answer "timeload".
            _onNewTimeLoading: function (ev) {
                const answer = () => this.fire("timeload", { time: ev.time });
                this._baseLayer.prefetchTime(ev.time).then(answer, (err) => {
                    // On a real error answer anyway, otherwise the slider would wait for its 3 s timeout.
                    if (!parts.isAbortError(err)) answer();
                });
            },

            // "Could you show time T instantly?"  (_baseLayer is the wind layer we wrap)
            isReady: function (time) {
                return this._baseLayer.isTimeReady(time);
            },

            // The player says how many future frames it will want soon.
            setMinimumForwardCache: function (n) {
                this._baseLayer.setMinimumForwardCache(n);
            },

            // Called when the layer is added to the map and whenever the clock switched to a new time.
            _update: function (ev) {
                const map = this._map;
                if (!map) return true;
                const time = ev && ev.time != null ? ev.time : this._timeDimension.getCurrentTime();
                if (time == null) return true;

                this._baseLayer.setTime(time);
                if (!map.hasLayer(this._baseLayer)) this._baseLayer.addTo(map);
                return true;
            }
        });

        L.timeDimension.layer.easyVelocity = function (layer, options) {
            return new L.TimeDimension.Layer.EasyVelocity(layer, options);
        };
        L.TimeDimension.Layer.WindField = L.TimeDimension.Layer.EasyVelocity;
        L.timeDimension.layer.windField = L.timeDimension.layer.easyVelocity;
        return true;
    };
})(globalThis);
