/*
 * gfs.js — helpers for NOAA's GFS weather model on the public AWS bucket
 * =======================================================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript, no dependencies.
 *
 * GFS (Global Forecast System) is NOAA's global weather model. It is run four times a day, at
 * 00, 06, 12 and 18 UTC; each run is called a CYCLE. Each cycle produces forecasts for many
 * hours ahead, one file per forecast hour: "f000" is the analysis (the model's picture of
 * "now"), "f003" is 3 hours later, and so on. Hourly steps up to f120, then every 3 hours.
 *
 * NOAA mirrors all of this in a public Amazon S3 bucket:
 *   https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.YYYYMMDD/HH/atmos/gfs.tHHz.pgrb2.0p25.fFFF
 *                                                  date      cycle          cycle  resolution  forecast hour
 * ("pgrb2" = the main parameter file in GRIB2, "0p25" = 0.25 degree grid.) The bucket allows
 * browser access (CORS) including Range requests, which is why we use it. Each file has a
 * companion ".idx" text file, see grib-loader.js.
 *
 * A cycle only appears several hours after its nominal time (the model has to run first), so
 * "latest cycle" below means "the newest one that is probably already published".
 *
 * ALSO HERE: GEFS, NOAA's ensemble (30 slightly perturbed GFS runs). We use its ENSEMBLE MEAN,
 * the average of all members, which is a smoother forecast on a 0.5 degree grid, on the sibling
 * bucket noaa-gefs-pds. Same file layout, same .idx files, same decoder.
 *
 * DATA LICENSE: NOAA data from these buckets are open to the public. NOAA asks for attribution
 * when the data are shown unaltered, and that you do not imply NOAA endorses your product.
 *
 * Everything below builds on the "time list" helper in time-sources.js.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

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

        const list = parts.timeList(hours.map((h) => ({ time: cycle + h * HOUR_MS, source: urlFor(cycle, h) })));
        return { cycle: new Date(cycle), hours, times: list.times, timeSource: list.timeSource };
    }

    /**
     * Everything needed to animate one forecast cycle with a time slider:
     *
     *   const f = L.easyVelocity.gfsForecast({ from: 0, to: 48, step: 3 });
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
        return parts.timeList(entries);
    }

    parts.gfsCycle = gfsCycle;
    parts.gfsUrl = gfsUrl;
    parts.gfsForecast = gfsForecast;
    parts.gefsMeanUrl = gefsMeanUrl;
    parts.gefsMeanForecast = gefsMeanForecast;
    parts.gfsAnalyses = gfsAnalyses;
})(globalThis);
