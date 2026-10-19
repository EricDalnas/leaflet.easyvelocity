/*
 * grib-loader.js — getting U/V data from a GRIB2 URL into a VelocityData
 * =======================================================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript apart from fetch(). Needs grib2-reader.js,
 * velocity-data.js and test-field.js; hands NetCDF sources to netcdf-loader.js (see loadSource).
 *
 * THE JOB
 * -------
 *   loadSource("https://.../gfs.t00z.pgrb2.0p25.f000", options)   ->  Promise<VelocityData>
 *   loadSource("test", options)                                     ->  Promise<VelocityData>
 *
 * THE PROBLEM
 * -----------
 * A NOAA GFS file is ~500 MB and contains ~700 fields; we need exactly two of them (the 10 m
 * U and V wind), about 2 MB. Downloading everything in a browser would be absurd, so there are
 * two strategies, tried in this order:
 *
 *   1. INDEX + RANGE REQUESTS (fast, ~2 MB).
 *      NOAA publishes a small text file next to every data file with the same name plus ".idx".
 *      It lists where each field starts in the big file, one line per field, for example:
 *
 *          585:414681348:d=2026100300:UGRD:10 m above ground:anl:
 *          ^   ^          ^           ^    ^                  ^
 *          |   |          |           |    level              forecast
 *          |   |          |           variable name
 *          |   |          run date + hour
 *          |   byte offset where this field's message begins in the data file
 *          line number
 *
 *      A field ends where the next one begins. HTTP supports "Range" requests ("send me only
 *      bytes 414681348 to 415650397"), so we can download just the two fields we need.
 *
 *   2. STREAMING (fallback when there is no .idx, or the server ignores Range).
 *      Download the file as a stream, cut it into messages as the bytes arrive, decode only
 *      the wanted ones, and cancel the download as soon as both U and V have been found.
 *      Depending on where they sit in the file this can still be a lot of data.
 *
 * Whichever strategy is used, the .idx text is only a HINT for where to look. What we actually
 * trust is the metadata inside each downloaded message (variable, level, time, grid).
 *
 * CORS (Cross-Origin Resource Sharing)
 * ------------------------------------
 * A browser only lets a web page read a response from ANOTHER website if that website's
 * response carries a header such as "Access-Control-Allow-Origin: *". The public NOAA bucket
 * on AWS sends it (also for Range requests); many servers do not. If it is missing, fetch()
 * fails with a generic network error, which is why the message below mentions CORS.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    /** fetch() rejects with an "AbortError" when we cancel it with an AbortController. */
    function isAbortError(e) {
        return !!e && e.name === "AbortError";
    }

    /** fetch() with friendlier errors. Status 206 ("Partial Content") is the success code for Range requests. */
    async function fetchChecked(url, init) {
        let response;
        try {
            response = await fetch(url, init);
        } catch (e) {
            if (isAbortError(e)) throw e;
            throw new Error("Could not fetch " + url +
                " — network error or the server does not allow cross-origin (CORS) requests from this page.");
        }
        if (!response.ok && response.status !== 206) {
            throw new Error("HTTP " + response.status + " " + response.statusText + " for " + url);
        }
        return response;
    }

    // ------------------------------------------------------------------
    // Choosing the right fields out of the parsed messages
    // ------------------------------------------------------------------

    /**
     * The GRIB value for the requested level. Height-above-ground levels are in metres, but
     * isobaric (pressure) levels are stored in PASCALS while people say hectopascals, so
     * "850 hPa" is stored as 85000.
     */
    function gribLevelValue(options) {
        return options.levelType === 100 ? options.level * 100 : options.level;
    }

    /** Is this field wind (discipline 0, category 2) at the requested level? */
    function isWindAtLevel(field, options) {
        return field.discipline === 0 && field.category === 2 &&
            field.levelType === options.levelType && field.levelValue === gribLevelValue(options);
    }

    /** Human-readable level, e.g. "10 m above ground" or "850 hPa". */
    function describeLevel(options) {
        return options.levelType === 103 ? options.level + " m above ground"
            : options.levelType === 100 ? options.level + " hPa"
                : "level " + options.level + " (type " + options.levelType + ")";
    }

    const isU = (field) => field.number === 2;   // U-component: towards the east
    const isV = (field) => field.number === 3;   // V-component: towards the north

    /**
     * Find a U field and a V field that belong together: same valid time AND exactly the same
     * grid. (Mixing e.g. U from 00:00 and V from 03:00 would produce nonsense.)
     */
    function pickPair(fields) {
        const us = fields.filter(isU);
        const vs = fields.filter(isV);
        for (const u of us) {
            const v = vs.find((x) =>
                x.validTime === u.validTime &&
                x.grid.ni === u.grid.ni && x.grid.nj === u.grid.nj &&
                x.grid.lat0 === u.grid.lat0 && x.grid.lon0 === u.grid.lon0 &&
                x.grid.dx === u.grid.dx && x.grid.dy === u.grid.dy);
            if (v) return { u, v };
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Strategy 1: the ".idx" file + HTTP Range requests
    // ------------------------------------------------------------------

    async function readViaIdx(url, options, wantedFn) {
        const text = await (await fetchChecked(url + ".idx", { signal: options.signal })).text();
        // Each line becomes [lineNumber, byteOffset, date, variable, level, forecast, ""].
        const rows = text.split("\n").filter(Boolean).map((line) => line.split(":"));

        // How NOAA spells the level in the .idx text.
        const levelText = options.levelType === 103 ? options.level + " m above ground"
            : options.levelType === 100 ? options.level + " mb"
                : null;
        if (!levelText) return null;       // other level types: fall back to streaming

        const uRow = rows.findIndex((r) => r[3] === "UGRD" && r[4] === levelText);
        const vRow = rows.findIndex((r) => r[3] === "VGRD" && r[4] === levelText);
        if (uRow < 0 || vRow < 0) return null;

        // Download one field: from its offset up to (but not including) the next field's offset.
        const downloadField = async (rowIndex) => {
            const start = +rows[rowIndex][1];
            const next = rows[rowIndex + 1];
            const range = "bytes=" + start + "-" + (next ? +next[1] - 1 : "");   // inclusive end byte
            const response = await fetchChecked(url, { signal: options.signal, headers: { Range: range } });
            if (response.status !== 206) {
                // The server ignored Range and is sending the whole file: stop immediately.
                if (response.body) response.body.cancel().catch(() => { });
                throw new Error("Server ignored Range request.");
            }
            return new Uint8Array(await response.arrayBuffer());
        };

        const [uBytes, vBytes] = await Promise.all([downloadField(uRow), downloadField(vRow)]);
        const fields = [];
        for (const bytes of [uBytes, vBytes]) fields.push(...parts.grib2.parseMessage(bytes, wantedFn));
        return pickPair(fields);
    }

    // ------------------------------------------------------------------
    // Strategy 2: stream the file and stop once U and V have been found
    // ------------------------------------------------------------------

    async function readStreaming(url, options, wantedFn) {
        const response = await fetchChecked(url, Object.assign({ signal: options.signal }, options.fetchOptions));

        // Very old browsers cannot stream: read everything, then split into messages.
        if (!response.body || !response.body.getReader) {
            const all = new Uint8Array(await response.arrayBuffer());
            const found = [];
            for (let p = 0; p < all.length;) {
                const length = parts.grib2.messageLength(all.subarray(p));
                found.push(...parts.grib2.parseMessage(all.subarray(p, p + length), wantedFn));
                p += length;
            }
            return pickPair(found);
        }

        // Network chunks arrive in arbitrary sizes that do not line up with messages. We queue
        // them and only glue them together once we have enough bytes for the next step:
        //   - 16 bytes, to read a message's header (which says how long the message is), then
        //   - the whole message.
        const reader = response.body.getReader();
        let buffer = new Uint8Array(0);   // bytes not yet consumed
        let queue = [];                   // chunks received but not yet appended to `buffer`
        let queuedBytes = 0;
        let bytesNeeded = 16;
        let downloaded = 0;
        const found = [];

        const mergeQueueIntoBuffer = () => {
            if (!queue.length) return;
            const merged = new Uint8Array(buffer.length + queuedBytes);
            merged.set(buffer);
            let offset = buffer.length;
            for (const chunk of queue) { merged.set(chunk, offset); offset += chunk.length; }
            buffer = merged;
            queue = [];
            queuedBytes = 0;
        };

        try {
            for (; ;) {
                const { done, value } = await reader.read();
                if (done) break;
                queue.push(value);
                queuedBytes += value.length;
                downloaded += value.length;
                if (options.onProgress) options.onProgress(downloaded);

                while (buffer.length + queuedBytes >= bytesNeeded) {
                    mergeQueueIntoBuffer();
                    if (!parts.grib2.isGribHeader(buffer)) {
                        if (parts.netcdf && (parts.netcdf.isNetcdf(buffer) || parts.netcdf.isHdf5(buffer))) {
                            throw new Error("Response is a NetCDF file, not GRIB2: use the layer option format: \"netcdf\".");
                        }
                        throw new Error("Response is not a GRIB2 file (the URL may return an HTML error page).");
                    }
                    const length = parts.grib2.messageLength(buffer);
                    if (buffer.length < length) { bytesNeeded = length; break; }   // wait for the rest

                    found.push(...parts.grib2.parseMessage(buffer.subarray(0, length), wantedFn));
                    buffer = buffer.subarray(length);    // consume the message
                    bytesNeeded = 16;

                    const pair = pickPair(found);
                    if (pair) return pair;               // got U and V: stop downloading
                }
            }
        } finally {
            reader.cancel().catch(() => { });            // abandon the rest of the download
        }
        return pickPair(found);
    }

    // ------------------------------------------------------------------
    // Putting it together
    // ------------------------------------------------------------------

    async function loadGrib2(url, options) {
        const wantedFn = (field) => isWindAtLevel(field, options) && (isU(field) || isV(field));

        let pair = null;
        let loadedVia = "stream";

        // .idx only exists for files on a data server, not for files bundled with the page (relative
        // URLs such as "data/file.grib2") and not for URLs with ?query strings (e.g. the NOMADS filter).
        if (/^https?:\/\//i.test(url) && !/[?#]/.test(url)) {
            try {
                pair = await readViaIdx(url, options, wantedFn);
                if (pair) loadedVia = "idx + Range requests";
            } catch (e) {
                if (isAbortError(e)) throw e;
                pair = null;      // no .idx, or Range not allowed: use the streaming strategy
            }
        }
        if (!pair) pair = await readStreaming(url, options, wantedFn);

        if (!pair) {
            throw new Error("No matching UGRD/VGRD pair at " + describeLevel(options) +
                " (same grid and forecast time) found in " + url);
        }

        const g = pair.u.grid;
        return new parts.VelocityData({
            lat0: g.lat0, lon0: g.lon0, dx: g.dx, dy: g.dy, ni: g.ni, nj: g.nj,
            u: pair.u.values,
            v: pair.v.values,
            info: {
                name: "GRIB2 UGRD/VGRD",
                units: "m/s",
                level: describeLevel(options),
                referenceTime: new Date(pair.u.refTime).toISOString(),
                validTime: new Date(pair.u.validTime).toISOString(),
                forecastHours: pair.u.forecastMs / 3600e3,
                loadedVia
            }
        });
    }

    /**
     * The single entry point used by the layer.
     *
     * @param {string|VelocityData} source  "test", a GRIB2 or NetCDF URL, or an already built VelocityData
     * @param {object} options
     *        format             "auto" (default: NetCDF if the URL looks like it, see netcdf-loader.js),
     *                           "grib2" or "netcdf"
     *        level, levelType   which level to pick (default 10 m above ground = 10, 103)
     *        hours              (test source only) hours since the first time shown
     *        signal             AbortSignal to cancel the download
     *        onProgress(bytes)  called while streaming
     *        fetchOptions       extra fetch() options (e.g. credentials), streaming / NetCDF download only
     * @returns {Promise<VelocityData>}
     */
    async function loadSource(source, options) {
        if (source instanceof parts.VelocityData) return source;
        if (typeof source !== "string" || !source.trim()) throw new Error("No data source specified.");
        if (source === "test") return parts.createTestField(options.hours);
        const url = source.trim();
        const format = options.format || "auto";
        if (format === "netcdf" || (format === "auto" && parts.isNetcdfUrl && parts.isNetcdfUrl(url))) {
            return parts.loadNetcdf(url, options);
        }
        return loadGrib2(url, options);
    }

    parts.isAbortError = isAbortError;
    parts.fetchChecked = fetchChecked;
    parts.loadSource = loadSource;
})(globalThis);
