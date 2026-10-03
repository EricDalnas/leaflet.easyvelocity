/*
 * time-sources.js — mapping clock times to data files
 * ====================================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript, no dependencies.
 *
 * A time slider (see time-dimension.js) deals in TIMES; the wind layer deals in SOURCES
 * (a file URL for each time step). This tiny helper builds the bridge from a plain list:
 *
 *   const sequence = L.easyVelocity.timeList([
 *       { time: "2022-09-28T06:00:00Z", source: "data/ian-06z.grib2" },
 *       { time: "2022-09-28T12:00:00Z", source: "data/ian-12z.grib2" },
 *   ]);
 *   sequence.times        [1664344800000, 1664366400000]   -> give to TimeDimension
 *   sequence.timeSource   (timeMs) => source of the NEAREST entry   -> give to L.easyVelocity
 *
 * "Nearest" means the slider can never ask for a file that does not exist: any time snaps to
 * the closest entry. `time` may be a Date, an ISO-8601 string or milliseconds since 1970.
 * Works for any kind of source, not only GRIB2 URLs.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    /**
     * @param {{time: Date|string|number, source: *}[]} entries
     * @returns {{times: number[], timeSource: (timeMs: number) => *}}
     */
    function timeList(entries) {
        const list = entries
            .map((entry) => ({ time: +new Date(entry.time), source: entry.source }))
            .sort((a, b) => a.time - b.time);

        const timeSource = (timeMs) => {
            let best = list[0];
            for (const entry of list) {
                if (Math.abs(entry.time - timeMs) < Math.abs(best.time - timeMs)) best = entry;
            }
            return best.source;
        };

        return { times: list.map((entry) => entry.time), timeSource };
    }

    parts.timeList = timeList;
})(globalThis);
