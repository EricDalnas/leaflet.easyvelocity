/*
 * netcdf-loader.js — getting U/V data from a NetCDF URL into a VelocityData
 * =======================================================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript apart from fetch(). Needs netcdf-reader.js,
 * netcdf4-reader.js (NetCDF-4 files only, plus the h5wasm script), velocity-data.js and grib-loader.js (for fetchChecked; grib-loader's loadSource() calls this file
 * for NetCDF sources).
 *
 * THE JOB
 * -------
 *   loadNetcdf("https://.../file.nc", options)                         ->  Promise<VelocityData>
 *   loadNetcdf("data/storm.nc#time=2022-12-23T12:00:00Z", options)    ->  that time step of the file
 *
 * Which URLs are treated as NetCDF: paths ending in .nc / .nc3 / .cdf / .netcdf, URLs asking a
 * server for NetCDF (e.g. "accept=netcdf"), or any source when the layer has format: "netcdf".
 *
 * THE URL FRAGMENT ("#...") SELECTS WHAT TO READ
 * ----------------------------------------------
 * A NetCDF file often holds several time steps. The part after "#" is never sent to the server,
 * so it is used to say which one to show (and, optionally, which variables are U and V):
 *     file.nc#time=2022-12-23T12:00:00Z          the time step nearest to this time
 *     file.nc#u=water_u&v=water_v               use these variables
 * Without #time the first time step is used. The file is downloaded ONCE and kept for the
 * other time steps (see `files` below). Because each "#time=" URL is a different string, the
 * layer's frame cache treats every time step as its own frame.
 *
 * FINDING U AND V IN THE FILE
 * ----------------------------
 * Unlike GRIB2, NetCDF has no fixed numbering of quantities; variables have free names. We look,
 * in this order, for:
 *   1. the names given in the URL fragment (#u=...&v=...);
 *   2. CF "standard_name" attributes: eastward_wind / northward_wind (also sea-water velocity);
 *   3. well-known names: wgrib2's UGRD_10maboveground, NOAA/ERDDAP's ugrd10m, ERA5's u10, ...;
 *   4. THREDDS/GRIB-style names: u-component_of_wind_height_above_ground, ...
 * The last two dimensions must be latitude and longitude on a regular grid. Other dimensions are
 * fixed at one index: time from #time, height/pressure from the layer's `level` option.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    // ------------------------------------------------------------------
    // Downloading, with one shared download per file
    // ------------------------------------------------------------------

    // url -> { promise, controller, users, listeners }. Several time steps of one file share one
    // download; the last two files are kept so that stepping through time does not re-download.
    const files = new Map();
    const MAX_FILES = 2;

    function abortError() {
        const e = new Error("Aborted");
        e.name = "AbortError";
        return e;
    }

    async function download(url, entry, fetchOptions) {
        const response = await parts.fetchChecked(url, Object.assign({}, fetchOptions, { signal: entry.controller.signal }));
        let bytes;
        if (!response.body || !response.body.getReader) {
            bytes = new Uint8Array(await response.arrayBuffer());
        } else {
            const reader = response.body.getReader();
            const chunks = [];
            let total = 0;
            for (; ;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                total += value.length;
                for (const listener of entry.listeners) listener(total);
            }
            bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        }
        if (parts.netcdf.isHdf5(bytes)) return parts.netcdf4.open(bytes);
        if (!parts.netcdf.isNetcdf(bytes)) {
            throw new Error("Response is not a NetCDF file (the URL may return an HTML error page): " + url);
        }
        return parts.netcdf.parse(bytes);
    }

    /**
     * The parsed file at `url`, downloading it if needed. Cancelling `options.signal` only
     * cancels the download when no other caller is still waiting for the same file.
     */
    function getFile(url, options) {
        let shared = files.get(url);
        if (!shared) {
            const entry = shared = { controller: new AbortController(), users: 0, listeners: new Set(), promise: null };
            entry.promise = download(url, entry, options.fetchOptions);
            entry.promise.catch(() => { if (files.get(url) === entry) files.delete(url); });   // allow a retry
            files.set(url, entry);
            while (files.size > MAX_FILES) {
                const oldest = files.keys().next().value;
                // NetCDF-4 files hold memory inside h5wasm; close them once current readers have finished.
                files.get(oldest).promise.then((file) => { if (file.close) setTimeout(() => file.close(), 0); }, () => { });
                files.delete(oldest);
            }
        }
        const signal = options.signal;
        if (signal && signal.aborted) return Promise.reject(abortError());

        shared.users++;
        if (options.onProgress) shared.listeners.add(options.onProgress);
        return new Promise((resolve, reject) => {
            let settled = false;
            const leave = () => {
                settled = true;
                shared.users--;
                if (options.onProgress) shared.listeners.delete(options.onProgress);
                if (signal) signal.removeEventListener("abort", onAbort);
            };
            const onAbort = () => {
                if (settled) return;
                leave();
                if (shared.users === 0) shared.controller.abort();   // nobody else wants this file
                reject(abortError());
            };
            if (signal) signal.addEventListener("abort", onAbort);
            shared.promise.then(
                (file) => { if (!settled) { leave(); resolve(file); } },
                (err) => { if (!settled) { leave(); reject(err); } });
        });
    }

    // ------------------------------------------------------------------
    // Understanding the file: axes, time, level
    // ------------------------------------------------------------------

    const attr = (v, name) => (v && v.attributes[name]) || "";

    function isLatitude(v) {
        return !!v && (/^degrees?_?n(orth)?$/i.test(attr(v, "units")) || attr(v, "standard_name") === "latitude" ||
            /^lat(itude)?$/i.test(v.name));
    }

    function isLongitude(v) {
        return !!v && (/^degrees?_?e(ast)?$/i.test(attr(v, "units")) || attr(v, "standard_name") === "longitude" ||
            /^lon(gitude)?$/i.test(v.name));
    }

    /** The coordinate variable of dimension `d`: the 1-D variable with the dimension's name. */
    function coordinate(file, d) {
        const name = file.dimensions[d].name;
        return file.variables.find((v) => v.name === name && v.dims.length === 1);
    }

    /** True if the last two dimensions of `v` are latitude, longitude. */
    function onLatLonGrid(file, v) {
        const n = v.dims.length;
        return n >= 2 && isLatitude(coordinate(file, v.dims[n - 2])) && isLongitude(coordinate(file, v.dims[n - 1]));
    }

    /** First value and step of an evenly spaced axis; throws for an uneven one. */
    function regularAxis(values, what) {
        const n = values.length;
        if (n < 2) throw new Error("NetCDF: the " + what + " axis needs at least 2 points.");
        const step = (values[n - 1] - values[0]) / (n - 1);
        for (let i = 0; i < n; i++) {
            if (!(Math.abs(values[i] - values[0] - i * step) <= Math.abs(step) * 0.01)) {
                throw new Error("NetCDF: the " + what + " axis is not evenly spaced; only regular lat/lon grids are supported.");
            }
        }
        return { start: values[0], step };
    }

    /**
     * CF time units, e.g. "seconds since 1970-01-01T00:00:00Z" or "hours since 2022-12-23 00:00:00.0 0:00",
     * as a function value -> milliseconds since 1970. Null if the units are not of this form.
     */
    function cfTimeDecoder(units) {
        const m = /^\s*(\w+)\s+since\s+(\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?)?\s*(Z|UTC|[+-]?\d{1,2}(?::?\d{2})?)?\s*$/i
            .exec(units || "");
        if (!m) return null;
        const unit = m[1].toLowerCase();
        const factor = /^s(ecs?|econds?)?$/.test(unit) ? 1e3 : /^min(s|utes?)?$/.test(unit) ? 6e4
            : /^(h|hrs?|hours?)$/.test(unit) ? 3.6e6 : /^(d|days?)$/.test(unit) ? 8.64e7 : 0;
        if (!factor) return null;
        let epoch = Date.UTC(+m[2], +m[3] - 1, +m[4], +(m[5] || 0), +(m[6] || 0)) + (+(m[7] || 0)) * 1e3;
        const zone = /^([+-]?)(\d{1,2}):?(\d{2})?$/.exec(m[8] || "");
        if (zone) epoch -= (zone[1] === "-" ? -1 : 1) * (+zone[2] * 60 + +(zone[3] || 0)) * 6e4;
        return (value) => epoch + value * factor;
    }

    function isTimeAxis(file, d, cv) {
        return file.dimensions[d].isRecord || attr(cv, "axis") === "T" || attr(cv, "standard_name") === "time" ||
            /\bsince\b/i.test(attr(cv, "units"));
    }

    /**
     * Fix every dimension except latitude/longitude at one index.
     * @returns {{index: number[], validTime: number|null, level: string}}
     */
    function chooseIndices(file, v, wantedTime, options) {
        const index = [];
        let validTime = null;
        let level = "";
        for (let k = 0; k < v.dims.length - 2; k++) {
            const d = v.dims[k];
            const dim = file.dimensions[d];
            const cv = coordinate(file, d);
            const values = cv ? parts.netcdf.readVariable(file, cv) : null;

            if (cv && isTimeAxis(file, d, cv)) {
                const decode = cfTimeDecoder(attr(cv, "units"));
                const times = decode ? Array.from(values, decode) : null;
                let best = 0;
                if (times && wantedTime !== null) {
                    for (let i = 1; i < times.length; i++) {
                        if (Math.abs(times[i] - wantedTime) < Math.abs(times[best] - wantedTime)) best = i;
                    }
                }
                index.push(best);
                if (times) validTime = times[best];
            } else if (dim.size === 1) {
                index.push(0);
                if (values) level = values[0] + " " + attr(cv, "units");
            } else if (values) {
                // A vertical axis: find the requested level. Pressure may be stored in Pa or hPa.
                const targets = options.levelType === 100 ? [options.level, options.level * 100] : [options.level];
                const i = values.findIndex((x) => targets.some((t) => Math.abs(x - t) <= 1e-6 * Math.max(1, Math.abs(t))));
                if (i < 0) {
                    throw new Error("NetCDF: level " + options.level + " not found on axis " + dim.name +
                        " (" + Array.from(values).join(", ") + " " + attr(cv, "units") + ").");
                }
                index.push(i);
                level = values[i] + " " + attr(cv, "units");
            } else {
                throw new Error("NetCDF: cannot choose an index on dimension " + dim.name + " of " + v.name + ".");
            }
        }
        return { index, validTime, level: level.trim() };
    }

    // ------------------------------------------------------------------
    // Finding the U and V variables
    // ------------------------------------------------------------------

    const STANDARD_NAMES = [
        ["eastward_wind", "northward_wind"],
        ["x_wind", "y_wind"],
        ["eastward_sea_water_velocity", "northward_sea_water_velocity"],
        ["surface_eastward_sea_water_velocity", "surface_northward_sea_water_velocity"]
    ];
    // [U name, V name, level they are at]
    const COMMON_NAMES = [["ugrd10m", "vgrd10m", "10 m above ground"], ["u10", "v10", "10 m above ground"],
        ["uwnd", "vwnd"], ["water_u", "water_v"], ["uo", "vo"], ["u", "v"], ["U", "V"]];

    function findVelocity(file, params, options) {
        const grids = file.variables.filter((v) => onLatLonGrid(file, v));
        const byName = (name) => grids.find((v) => v.name === name);
        const sameShape = (u, v) => u && v && u.dims.join() === v.dims.join();

        if (params.has("u") || params.has("v")) {
            const u = byName(params.get("u"));
            const v = byName(params.get("v"));
            if (!sameShape(u, v)) throw new Error("NetCDF: variables " + params.get("u") + " / " + params.get("v") +
                " not found, or not on the same latitude/longitude grid.");
            return { u, v };
        }

        for (const [uName, vName] of STANDARD_NAMES) {
            for (const u of grids.filter((x) => attr(x, "standard_name") === uName)) {
                const v = grids.find((x) => attr(x, "standard_name") === vName && sameShape(u, x));
                if (v) return { u, v };
            }
        }

        // wgrib2 -netcdf names fields after the GRIB2 inventory: UGRD_10maboveground, UGRD_850mb, ...
        const levelName = options.levelType === 103 ? options.level + "maboveground"
            : options.levelType === 100 ? options.level + "mb" : null;
        const pairs = levelName ? [["UGRD_" + levelName, "VGRD_" + levelName]].concat(COMMON_NAMES) : COMMON_NAMES;
        for (const [uName, vName] of pairs) {
            const u = byName(uName);
            const v = byName(vName);
            if (sameShape(u, v)) return { u, v };
        }

        // THREDDS names GRIB fields like "u-component_of_wind_height_above_ground" / "..._isobaric".
        const preferred = options.levelType === 100 ? "isobaric" : "height_above_ground";
        const gribStyle = grids.filter((x) => /^u-component_of_wind/.test(x.name))
            .sort((a, b) => (b.name.includes(preferred) ? 1 : 0) - (a.name.includes(preferred) ? 1 : 0));
        for (const u of gribStyle) {
            const v = byName(u.name.replace(/^u-/, "v-"));
            if (sameShape(u, v)) return { u, v };
        }

        throw new Error("NetCDF: no U/V velocity variables found. Variables on a lat/lon grid: " +
            (grids.map((x) => x.name).join(", ") || "none") + ". Name them in the URL, e.g. file.nc#u=NAME&v=NAME");
    }

    // ------------------------------------------------------------------
    // Putting it together
    // ------------------------------------------------------------------

    /** Should this source be read as NetCDF? */
    function isNetcdfUrl(url) {
        const path = url.split(/[?#]/)[0];
        return /\.(nc|nc3|cdf|netcdf)$/i.test(path) || /[?&](accept|format)=netcdf/i.test(url);
    }

    /**
     * @param {string} source  a NetCDF URL, optionally with #time=...&u=...&v=...
     * @param {object} options  as for loadSource() in grib-loader.js
     * @returns {Promise<VelocityData>}
     */
    async function loadNetcdf(source, options) {
        const hash = source.indexOf("#");
        const url = hash < 0 ? source : source.slice(0, hash);
        const params = new URLSearchParams(hash < 0 ? "" : source.slice(hash + 1));
        const timeText = params.get("time");
        const wantedTime = timeText === null ? null : +new Date(/^-?\d+$/.test(timeText) ? +timeText : timeText);
        if (wantedTime !== null && isNaN(wantedTime)) throw new Error("NetCDF: cannot read #time=" + timeText);

        const file = await getFile(url, options);
        const { u, v } = findVelocity(file, params, options);
        const n = u.dims.length;
        const lat = regularAxis(parts.netcdf.readVariable(file, coordinate(file, u.dims[n - 2])), "latitude");
        const lon = regularAxis(parts.netcdf.readVariable(file, coordinate(file, u.dims[n - 1])), "longitude");
        const chosen = chooseIndices(file, u, wantedTime, options);
        const known = COMMON_NAMES.find((pair) => pair[0] === u.name);

        return new parts.VelocityData({
            lat0: lat.start, dy: lat.step, nj: u.shape[n - 2],
            lon0: lon.start, dx: lon.step, ni: u.shape[n - 1],
            u: parts.netcdf.readVariable(file, u, chosen.index, Float32Array),
            v: parts.netcdf.readVariable(file, v, chosen.index, Float32Array),
            info: {
                name: "NetCDF " + u.name + "/" + v.name,
                units: attr(u, "units") || "m/s",
                level: chosen.level || attr(u, "level") || (known && known[2]) || u.name + "/" + v.name,
                validTime: chosen.validTime === null ? undefined : new Date(chosen.validTime).toISOString(),
                loadedVia: { 1: "NetCDF classic", 2: "NetCDF 64-bit offset", 4: "NetCDF-4" }[file.version] || "NetCDF CDF-5"
            }
        });
    }

    parts.isNetcdfUrl = isNetcdfUrl;
    parts.loadNetcdf = loadNetcdf;
})(globalThis);
