/*
 * test-field.js — a synthetic wind field for development
 * =======================================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript. Needs wind-data.js.
 *
 * Real GRIB2 files are large and need network access (and CORS permission). This generator
 * produces an instantly available, visually obvious wind field so the map, the particles,
 * the colour scale and the time slider can all be developed and demonstrated offline.
 *
 * Use it with  L.easyVelocity({ source: "test" }).
 *
 * WHAT THE FIELD CONTAINS
 *   - A westerly jet: a band of eastward wind around 40 N that fades towards the tropics/poles.
 *   - A north-south wave pattern (the sin() term) so the flow meanders.
 *   - Two cyclones and one anticyclone: whirling "vortices". In the northern hemisphere a
 *     cyclone turns counter-clockwise and an anticyclone clockwise.
 *   - A small circular "no data" hole near 46 N, 62 W (NaN values) to show how particles
 *     disappear and respawn where data is missing.
 *
 * TIME: pass `hours` and the whole pattern drifts east, so the time slider has something to show.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    /**
     * @param {number} [hours]  hours since the first time shown; 0 = initial pattern
     * @returns {WindData}      global 1-degree grid (360 x 181 points), lat 90..-90, lon -180..179
     */
    function createTestField(hours) {
        hours = hours || 0;
        const ni = 360;
        const nj = 181;
        const u = new Float32Array(ni * nj);
        const v = new Float32Array(ni * nj);
        const DEG_TO_RAD = Math.PI / 180;

        // Each vortex: centre, radius R of strongest wind (degrees), peak speed S (m/s),
        // and dir = +1 for counter-clockwise (cyclone) or -1 for clockwise (anticyclone).
        const vortices = [
            { lat: 38, lon: -88, R: 7, S: 13, dir: 1 },
            { lat: 30, lon: -60, R: 9, S: 10, dir: -1 },
            { lat: 52, lon: -70, R: 6, S: 9, dir: 1 }
        ];

        for (let j = 0; j < nj; j++) {
            const lat = 90 - j;
            for (let i = 0; i < ni; i++) {
                const lon = -180 + i;

                // Background flow: jet (eastward, strongest near 40 N) plus a meandering north-south wave.
                let uu = 9 * Math.cos((lat - 40) * DEG_TO_RAD * 3) + 3;
                let vv = 5 * Math.sin((lon - 3 * hours) * DEG_TO_RAD * 4) * Math.cos(lat * DEG_TO_RAD);

                // Add the swirl of each vortex. The wind around a vortex is perpendicular to the
                // line from its centre: for an offset (dxx east, dyy north) from the centre the
                // counter-clockwise direction is (-dyy, +dxx) / distance.
                for (const c of vortices) {
                    // Drift east with time, and take the shortest way around the globe.
                    const dlon = ((((lon - c.lon - 1.5 * hours + 180) % 360) + 360) % 360) - 180;
                    const dxx = dlon * Math.cos(lat * DEG_TO_RAD);   // degrees of longitude shrink towards the poles
                    const dyy = lat - c.lat;
                    const r = Math.hypot(dxx, dyy) || 1e-6;          // distance from centre (avoid dividing by 0)
                    // Wind speed rises linearly to a peak at r = R, then decays.
                    const speed = c.S * (r / c.R) * Math.exp(1 - r / c.R);
                    uu += -c.dir * speed * dyy / r;
                    vv += c.dir * speed * dxx / r;
                }

                const k = j * ni + i;
                const insideHole = Math.hypot(lon + 62, lat - 46) < 2.5;
                u[k] = insideHole ? NaN : uu;
                v[k] = insideHole ? NaN : vv;
            }
        }

        return new parts.WindData({
            lat0: 90, lon0: -180, dx: 1, dy: -1, ni, nj, u, v,
            info: { name: "Synthetic test field", units: "m/s" }
        });
    }

    parts.createTestField = createTestField;
})(globalThis);
