/*
 * velocity-data.js — a velocity grid you can ask "what is the flow at this latitude/longitude?"
 * ==========================================================================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript: no Leaflet, no DOM, no network.
 *
 * This is the one data structure shared by BOTH halves of the plugin:
 *   - the loaders (grib-loader.js, netcdf-loader.js, test-field.js) BUILD a VelocityData from whatever they read;
 *   - the Leaflet layer (leaflet.easyvelocity.js and friends) only ever ASKS a VelocityData for vectors.
 * Because of that, the drawing code never needs to know whether the numbers came from a
 * GRIB2 file, a NetCDF file or a test generator, nor whether they are wind, ocean currents or
 * any other U/V field.
 *
 * WHAT IS STORED
 * --------------
 * A regular latitude/longitude grid with two values per point, U and V:
 *   u  how fast the air / water moves towards the EAST  (m/s)   negative = towards the west
 *   v  how fast the air / water moves towards the NORTH (m/s)   negative = towards the south
 * SPEED is sqrt(u*u + v*v). The direction of flow (TOWARDS) follows from atan2(u, v).
 * (Meteorologists name a wind by where it comes FROM, 180 degrees opposite; oceanographers
 * name a current by where it goes TO.)
 *
 * Grid point (i, j) is at   longitude = lon0 + i * dx     latitude = lat0 + j * dy
 * and its numbers live at   index = j * ni + i            in the u and v arrays.
 * dx and dy are SIGNED: GFS has dy < 0 because it starts at the north pole and goes south.
 *
 * Missing data is stored as NaN ("not a number") and is handled everywhere downstream.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    class VelocityData {
        /**
         * @param {object} g
         * @param {number} g.lat0  latitude of the first row
         * @param {number} g.lon0  longitude of the first column
         * @param {number} g.dx    longitude step between columns, degrees (negative = westwards)
         * @param {number} g.dy    latitude step between rows, degrees (negative = southwards)
         * @param {number} g.ni    number of columns
         * @param {number} g.nj    number of rows
         * @param {Float32Array} g.u  eastward velocity, length ni * nj
         * @param {Float32Array} g.v  northward velocity, length ni * nj
         * @param {object} [g.info]   free-form description (name, valid time, ...) shown in the UI
         */
        constructor(g) {
            this.lat0 = g.lat0;
            this.lon0 = g.lon0;
            this.dx = g.dx;
            this.dy = g.dy;
            this.ni = g.ni;
            this.nj = g.nj;
            this.u = g.u;
            this.v = g.v;
            this.info = g.info || {};

            // A "global" grid covers all 360 degrees of longitude, so the last column is
            // adjacent to the first one (we can wrap around the date line). 0.25 degrees * 1440
            // columns = 360 exactly.
            const stepSize = Math.abs(this.dx);
            this.global = Math.abs(this.ni * stepSize - 360) < stepSize * 0.01;
        }

        /**
         * Bilinear interpolation of the velocity at any latitude/longitude.
         *
         * Allocation-free on purpose: this runs hundreds of thousands of times each time the
         * map moves, so it writes into a caller-supplied array instead of creating an object.
         * Use getVector() below if you just want a convenient object.
         *
         * @param {number} lat
         * @param {number} lon  any longitude; -75 and 285 mean the same place
         * @param {Float32Array} out  receives u in out[0] and v in out[1]
         * @returns {boolean} false if the point is outside the grid or on missing data
         */
        sample(lat, lon, out) {
            const ni = this.ni;
            const nj = this.nj;

            // STEP 1 — where does the latitude fall between the grid rows?
            // rowF = 3.25 means "a quarter of the way from row 3 to row 4".
            const rowF = (lat - this.lat0) / this.dy;
            if (!(rowF >= 0 && rowF <= nj - 1)) return false;   // north or south of the grid

            // STEP 2 — the same for longitude. First normalise it: how many degrees EAST of the
            // grid's first column are we, wrapped into the range 0..360? (This is what lets a
            // map that has been scrolled past the date line still find its data.)
            const eastward = this.dx < 0 ? -1 : 1;
            let degreesFromStart = (lon - this.lon0) * eastward;
            degreesFromStart = ((degreesFromStart % 360) + 360) % 360;   // JS "%" can be negative
            const colF = degreesFromStart / Math.abs(this.dx);
            if (!this.global && colF > ni - 1) return false;             // regional grid: outside it

            // STEP 3 — find the four grid points around the requested location.
            //
            //        col0         col1
            // row0   v00 ───────── v10
            //         │      •       │      • = requested point, tx / ty = how far across it is
            // row1   v01 ───────── v11              (0 = on the first point, 1 = on the second)
            //
            let col0 = Math.floor(colF);
            const row0 = Math.floor(rowF);
            const tx = colF - col0;
            const ty = rowF - row0;
            let col1 = col0 + 1;
            let row1 = row0 + 1;
            if (col1 >= ni) col1 = this.global ? col1 - ni : ni - 1;   // wrap past the last column
            if (col0 >= ni) col0 -= ni;
            if (row1 >= nj) row1 = nj - 1;                             // the last row has no row below

            const i00 = row0 * ni + col0;
            const i10 = row0 * ni + col1;
            const i01 = row1 * ni + col0;
            const i11 = row1 * ni + col1;

            // STEP 4 — blend. First along the top and bottom edges (weighted by tx), then
            // between those two results (weighted by ty):
            //     result = lerp( lerp(v00, v10, tx),  lerp(v01, v11, tx),  ty )
            // where lerp(a, b, t) = a * (1 - t) + b * t.
            const u = this.u;
            const v = this.v;
            const uu = (u[i00] * (1 - tx) + u[i10] * tx) * (1 - ty) + (u[i01] * (1 - tx) + u[i11] * tx) * ty;
            const vv = (v[i00] * (1 - tx) + v[i10] * tx) * (1 - ty) + (v[i01] * (1 - tx) + v[i11] * tx) * ty;

            // If ANY of the four corners was NaN (missing), the blend is NaN too, and
            // "NaN !== NaN" is true. We then report "no data here" instead of a wrong number.
            if (uu !== uu || vv !== vv) return false;

            out[0] = uu;
            out[1] = vv;
            return true;
        }

        /**
         * Convenience wrapper around sample().
         * @returns {{u:number, v:number, speed:number} | null}  null where there is no data
         */
        getVector(lat, lon) {
            const out = new Float32Array(2);
            if (!this.sample(lat, lon, out)) return null;
            return { u: out[0], v: out[1], speed: Math.sqrt(out[0] * out[0] + out[1] * out[1]) };
        }
    }

    parts.VelocityData = VelocityData;
})(globalThis);
