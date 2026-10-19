/*
 * noaa.js — demo helper: URLs for NOAA's GFS and GEFS models on the public AWS buckets.
 * Not part of the plugin; any page can build its own URLs and pass them to L.easyVelocity.
 *
 * GFS runs four times a day (00, 06, 12, 18 UTC), one file per forecast hour:
 *   https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.YYYYMMDD/HH/atmos/gfs.tHHz.pgrb2.0p25.fFFF
 * A run appears a few hours after its nominal time, so "latest" means now minus 5 hours.
 * NOAA asks for attribution and no implied endorsement when the data is shown.
 */
(function () {
    "use strict";

    const timeList = L.easyVelocity.timeList;

    const HOUR_MS = 3600e3;

    /**
     * Start (UTC) of the 6-hourly GFS cycle that contains `date`.
     * With no argument: the latest cycle that is likely published (now minus 5 hours, floored to 00/06/12/18).
     */
    function gfsCycle(date) {
        const t = date ? new Date(date) : new Date(Date.now() - 5 * HOUR_MS);
        t.setUTCMinutes(0, 0, 0);
        t.setUTCHours(Math.floor(t.getUTCHours() / 6) * 6);
        return t;
    }

    /**
     * URL of one GFS file.
     * @param {object} [opts]
     * @param {Date|number|string} [opts.date]  picks the cycle (default: latest)
     * @param {number} [opts.forecastHour]      0 = analysis, 3 = three hours ahead, ... (default 0)
     * @param {string} [opts.resolution]        "0p25" (default), "0p50" or "1p00"
     */
    function gfsUrl(opts) {
        opts = opts || {};
        const resolution = opts.resolution || "0p25";
        const forecastHour = String(opts.forecastHour || 0).padStart(3, "0");   // 3 -> "003"
        const cycle = gfsCycle(opts.date);
        const ymd = cycle.getUTCFullYear() +
            String(cycle.getUTCMonth() + 1).padStart(2, "0") +
            String(cycle.getUTCDate()).padStart(2, "0");
        const hh = String(cycle.getUTCHours()).padStart(2, "0");
        return "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs." + ymd + "/" + hh + "/atmos/gfs.t" + hh +
            "z.pgrb2." + resolution + ".f" + forecastHour;
    }

    /**
     * URL of one GEFS ensemble-MEAN file (0.5 degree grid). Options as for gfsUrl, without resolution.
     */
    function gefsMeanUrl(opts) {
        opts = opts || {};
        const forecastHour = String(opts.forecastHour || 0).padStart(3, "0");
        const cycle = gfsCycle(opts.date);
        const ymd = cycle.getUTCFullYear() +
            String(cycle.getUTCMonth() + 1).padStart(2, "0") +
            String(cycle.getUTCDate()).padStart(2, "0");
        const hh = String(cycle.getUTCHours()).padStart(2, "0");
        return "https://noaa-gefs-pds.s3.amazonaws.com/gefs." + ymd + "/" + hh + "/atmos/pgrb2ap5/geavg.t" + hh +
            "z.pgrb2a.0p50.f" + forecastHour;
    }

    /**
     * Shared by gfsForecast and gefsMeanForecast: one entry per forecast hour of one cycle.
     * `urlFor(cycleMs, forecastHour)` builds the URL of a step.
     */
    function forecastSteps(opts, urlFor) {
        opts = opts || {};
        const from = opts.from || 0;
        const to = opts.to == null ? 48 : opts.to;
        const step = opts.step || 3;
        const cycle = gfsCycle(opts.cycle).getTime();

        const hours = [];
        for (let h = from; h <= to; h += step) hours.push(h);

        const list = timeList(hours.map((h) => ({ time: cycle + h * HOUR_MS, source: urlFor(cycle, h) })));
        return { cycle: new Date(cycle), hours, times: list.times, timeSource: list.timeSource };
    }

    /**
     * Everything needed to animate one forecast cycle with a time slider:
     *
     *   const f = noaa.gfsForecast({ from: 0, to: 48, step: 3 });
     *   f.times        valid times in milliseconds, one per step (give these to TimeDimension)
     *   f.timeSource   function(timeMs) -> URL of the file for that time (give to L.easyVelocity)
     *
     * Times between steps snap to the nearest available step, so the slider can never request a
     * file that does not exist.
     *
     * @param {object} [opts]
     * @param {number} [opts.from=0]    first forecast hour
     * @param {number} [opts.to=48]     last forecast hour
     * @param {number} [opts.step=3]    hours between steps
     * @param {Date|number|string} [opts.cycle]  which cycle (default: latest)
     * @param {string} [opts.resolution]  "0p25" (default), "0p50" or "1p00"
     */
    function gfsForecast(opts) {
        const resolution = opts && opts.resolution;
        return forecastSteps(opts, (cycle, h) => gfsUrl({ date: cycle, forecastHour: h, resolution }));
    }

    /** Same as gfsForecast, for the GEFS ensemble mean (0.5 degrees, 3-hourly to 10 days). */
    function gefsMeanForecast(opts) {
        return forecastSteps(opts, (cycle, h) => gefsMeanUrl({ date: cycle, forecastHour: h }));
    }

    /**
     * The recent PAST: the analyses (forecast hour 0, the model's best picture of "now") of the
     * last `cycles` 6-hourly cycles, oldest first. Because it is computed from the clock it
     * always shows the latest couple of days.
     *
     * @param {object} [opts]
     * @param {number} [opts.cycles=8]  how many cycles back (8 = two days)
     * @param {string} [opts.resolution]
     * @returns {{times: number[], timeSource: function}}
     */
    function gfsAnalyses(opts) {
        opts = opts || {};
        const count = opts.cycles || 8;
        const latest = gfsCycle(opts.cycle).getTime();
        const entries = [];
        for (let i = count - 1; i >= 0; i--) {
            const cycle = latest - i * 6 * HOUR_MS;
            entries.push({ time: cycle, source: gfsUrl({ date: cycle, forecastHour: 0, resolution: opts.resolution }) });
        }
        return timeList(entries);
    }

    window.noaa = { gfsCycle, gfsUrl, gfsForecast, gfsAnalyses, gefsMeanUrl, gefsMeanForecast };
})();
