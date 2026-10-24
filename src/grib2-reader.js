/*
 * grib2-reader.js — a minimal GRIB2 file reader
 * ==============================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript.
 * Needs grib2-unpack.js to be loaded first.
 *
 * WHAT IS GRIB2?
 * --------------
 * GRIB2 ("GRIdded Binary, edition 2") is the World Meteorological Organization (WMO)
 * standard container for weather model output. NOAA, ECMWF, DWD and most national weather
 * services publish their forecasts in it. It is a compact binary format designed in the 1980s
 * for slow networks, which is why it looks nothing like JSON.
 *
 * A GRIB2 FILE is a plain concatenation of MESSAGES.
 *
 *   one MESSAGE = one weather field = one variable, at one level, at one time, on one grid
 *   e.g. "U-component of wind, 10 m above ground, valid 2026-10-03 00:00 UTC"
 *
 * A NOAA GFS file holds ~700 messages (every variable at every level). We only want two of
 * them (U and V wind), so a lot of this file is about FINDING the right messages cheaply.
 *
 * ANATOMY OF A MESSAGE: it is a list of SECTIONS
 * ----------------------------------------------
 *   Section 0  Indicator       the letters "GRIB", the discipline, edition (=2), total length
 *   Section 1  Identification  when the forecast run started ("reference time")
 *   Section 2  Local use       optional, ignored here
 *   Section 3  Grid definition how many points, where they are, in what order they are stored
 *   Section 4  Product         WHAT the field is: which variable, which level, how many hours ahead
 *   Section 5  Data recipe     how the numbers were packed (decoded by grib2-unpack.js)
 *   Section 6  Bitmap          optional: which grid points have no data at all
 *   Section 7  Data            the packed numbers themselves
 *   Section 8  End             the four ASCII characters "7777"
 *
 * (Sections 3-7 may repeat inside one message to hold several fields. NOAA does not do that,
 *  but the loop below handles it anyway.)
 *
 * Every section except 0 and 8 starts the same way: a 4-byte LENGTH, then a 1-byte SECTION
 * NUMBER. So we can walk through a message without understanding it: read the length, look at
 * the number, and jump ahead by "length" bytes to the next section.
 *
 * READING THE SPECIFICATION
 * -------------------------
 * The GRIB2 specification documents each section as a table of "octets" (bytes), numbered
 * starting at 1. The helpers u8 / u16 / u32 / f32 / signedInt below take those SAME 1-based
 * octet numbers, so every line of code can be checked against the spec table directly:
 *
 *      const ni = u32(view, sectionStart, 31);   // "Octets 31-34: Ni, points along a parallel"
 *
 * All multi-byte numbers in GRIB2 are BIG-ENDIAN (most significant byte first), which is the
 * default for JavaScript's DataView.
 *
 * HOW A WIND FIELD IS IDENTIFIED (WMO code tables)
 * ------------------------------------------------
 *   discipline  0   Meteorological products
 *   category    2   Momentum
 *   number      2   U-component of wind  (speed towards the EAST,  in m/s)   a.k.a. UGRD
 *   number      3   V-component of wind  (speed towards the NORTH, in m/s)   a.k.a. VGRD
 *   level type  103 "Specified height level above ground", the value is metres: 10 => 10 m
 *
 * Wind is therefore NOT stored as "speed and direction" but as two numbers (u, v):
 *      speed = sqrt(u^2 + v^2)
 * That is also what the animation needs: u moves a particle east-west, v north-south.
 *
 * WHAT THIS FILE SUPPORTS (and what it rejects with a clear error message)
 * ------------------------------------------------------------------------
 *   Edition 2 only                                  (GRIB1 files are rejected)
 *   Grid template 3.0: regular latitude/longitude   (projected / rotated / reduced grids rejected)
 *   Data templates 5.0, 5.2, 5.3                    (JPEG2000 / PNG / CCSDS rejected)
 *
 * THE DECODER CONTRACT (so another decoder, e.g. a library, can replace this file)
 * --------------------------------------------------------------------------------
 * The rest of leaflet.easyvelocity only calls parts.grib2.parseMessage(bytes, wanted) and expects an
 * array of "fields" shaped like this:
 *
 *   { discipline, category, number,          which variable (see above)
 *     levelType, levelValue,                 which level
 *     refTime, forecastMs, validTime,        milliseconds since 1970-01-01 UTC, and an offset
 *     grid:   { ni, nj, lat0, lon0, dx, dy, numPoints },
 *     values: Float32Array }                 one value per grid point, NaN = missing
 *
 * Anything that produces that shape can be swapped in without touching the loader or layer.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    // The ASCII letters "GRIB" and "7777" read as 32-bit big-endian integers.
    const MAGIC_GRIB = 0x47524942;
    const MAGIC_7777 = 0x37373737;

    // ------------------------------------------------------------------
    // Reading numbers by their specification octet number (1-based)
    // ------------------------------------------------------------------
    // `view` is a DataView over the message, `s` is the byte index where the current section
    // starts. Octet N of the section is therefore at byte index (s + N - 1).

    const u8 = (view, s, octet) => view.getUint8(s + octet - 1);
    const u16 = (view, s, octet) => view.getUint16(s + octet - 1);
    const u32 = (view, s, octet) => view.getUint32(s + octet - 1);
    const f32 = (view, s, octet) => view.getFloat32(s + octet - 1);

    /** 8-byte unsigned integer. (JS numbers are exact up to 2^53, plenty for message sizes.) */
    const u64 = (view, s, octet) => u32(view, s, octet) * 4294967296 + u32(view, s, octet + 4);

    /** Signed integer of `byteCount` bytes (GRIB2 uses sign-magnitude, see grib2-unpack.js). */
    function signedInt(view, s, octet, byteCount) {
        let raw = 0;
        for (let i = 0; i < byteCount; i++) raw = raw * 256 + u8(view, s, octet + i);
        return parts.unpack.decodeSignMagnitude(raw, byteCount * 8);
    }

    // ------------------------------------------------------------------
    // Section 1 — Identification: the "reference time"
    // ------------------------------------------------------------------

    /**
     * The reference time is when the forecast model run STARTED (e.g. the 00:00 UTC run).
     * The time the field is valid for is this plus the forecast offset from Section 4.
     */
    function parseIdentificationSection(view, s) {
        const refTime = Date.UTC(
            u16(view, s, 13),        // year
            u8(view, s, 15) - 1,     // month (GRIB: 1-12, JavaScript: 0-11)
            u8(view, s, 16),         // day
            u8(view, s, 17),         // hour
            u8(view, s, 18),         // minute
            u8(view, s, 19)          // second
        );
        return { refTime };
    }

    // ------------------------------------------------------------------
    // Section 3 — Grid definition (template 3.0: regular latitude/longitude)
    // ------------------------------------------------------------------
    //
    // A regular lat/lon grid is a rectangle of evenly spaced points:
    //
    //        lon0 ─────────────────────────► (i grows, step dx)
    //   lat0  *  *  *  *  *  *  *  *
    //         *  *  *  *  *  *  *  *      ni points per row, nj rows
    //         *  *  *  *  *  *  *  *      the values are stored row after row,
    //   (j grows, step dy)                 so point (i, j) is value number  j * ni + i
    //
    // GFS 0.25 degrees: ni = 1440 (360 / 0.25), nj = 721 (180 / 0.25 + 1),
    // starting at the north pole (lat 90) going south, and at longitude 0 going east.
    //
    // The "scanning mode" byte says in which direction rows/columns are stored. The usual
    // value 0 means: west -> east along each row, rows ordered north -> south.

    function parseGridSection(view, s) {
        const template = u16(view, s, 13);
        if (template !== 0) {
            throw new Error("Unsupported GRIB2 grid template 3." + template +
                " (only regular lat/lon, 3.0, is supported).");
        }

        const ni = u32(view, s, 31);                          // points along a row (west-east)
        const nj = u32(view, s, 35);                          // number of rows (north-south)
        // Angles are stored as integers in millionths of a degree ("micro-degrees").
        const lat1 = signedInt(view, s, 47, 4) / 1e6;         // latitude of the first point
        const lon1 = signedInt(view, s, 51, 4) / 1e6;         // longitude of the first point
        const lat2 = signedInt(view, s, 56, 4) / 1e6;         // latitude of the last point
        const lon2 = signedInt(view, s, 60, 4) / 1e6;         // longitude of the last point
        let stepLon = u32(view, s, 64) / 1e6;                 // spacing between columns
        let stepLat = u32(view, s, 68) / 1e6;                 // spacing between rows
        const scanning = u8(view, s, 72);

        // Bit flags of the scanning mode (bit 1 is the most significant bit):
        //   0x80  set => points run EAST -> WEST       (default: west -> east)
        //   0x40  set => rows run SOUTH -> NORTH       (default: north -> south)
        //   0x20  set => neighbours are along the j axis first (transposed): not supported
        //   0x10  set => every other row is reversed ("boustrophedon"): not supported
        if (scanning & 0x20) throw new Error("Unsupported GRIB2 scanning mode (adjacent points in j direction).");
        if (scanning & 0x10) throw new Error("Unsupported GRIB2 scanning mode (alternating row direction).");

        // If a step is missing, derive it from the first and last point.
        if (!stepLon && ni > 1) stepLon = Math.abs(((lon2 - lon1) % 360 + 360) % 360) / (ni - 1);
        if (!stepLat && nj > 1) stepLat = Math.abs(lat2 - lat1) / (nj - 1);

        return {
            ni, nj,
            lat0: lat1, lon0: lon1,
            // Signed steps: point (i, j) is at  lon = lon0 + i*dx,  lat = lat0 + j*dy.
            dx: (scanning & 0x80) ? -stepLon : stepLon,
            dy: (scanning & 0x40) ? stepLat : -stepLat,
            numPoints: u32(view, s, 7)
        };
    }

    // ------------------------------------------------------------------
    // Section 4 — Product definition: WHAT is this field?
    // ------------------------------------------------------------------

    // Code table 4.4: the unit of the "forecast time" number, in milliseconds.
    const FORECAST_UNIT_MS = {
        0: 60e3,          // minute
        1: 3600e3,        // hour
        2: 86400e3,       // day
        10: 3 * 3600e3,   // 3 hours
        11: 6 * 3600e3,   // 6 hours
        12: 12 * 3600e3,  // 12 hours
        13: 1e3           // second
    };

    /**
     * The first 28 octets are identical for all the common product templates (4.0, 4.1, ...),
     * and they contain everything we need, so we do not look at the template number.
     */
    function parseProductSection(view, s, identification) {
        const unitMs = FORECAST_UNIT_MS[u8(view, s, 18)] || 3600e3;
        const forecastSteps = u32(view, s, 19);           // "how many units after the reference time"

        // A level is stored as  scaledValue / 10^scaleFactor  (e.g. 10 / 10^0 = 10 metres).
        const levelScale = signedInt(view, s, 24, 1);
        const levelValue = u32(view, s, 25) / Math.pow(10, levelScale);

        const refTime = identification ? identification.refTime : NaN;
        return {
            category: u8(view, s, 10),
            number: u8(view, s, 11),
            levelType: u8(view, s, 23),
            levelValue,
            refTime,
            forecastMs: forecastSteps * unitMs,
            validTime: refTime + forecastSteps * unitMs   // the moment this field describes
        };
    }

    // ------------------------------------------------------------------
    // Section 5 — Data representation: the packing recipe
    // ------------------------------------------------------------------
    // The meaning of every field is explained at the top of grib2-unpack.js.

    function parseDataRepresentationSection(view, s) {
        const recipe = {
            numValues: u32(view, s, 6),             // how many packed values Section 7 holds
            template: u16(view, s, 10),             // 0 = simple, 2/3 = complex (+ differencing)
            referenceValue: f32(view, s, 12),       // "R"
            binaryScale: signedInt(view, s, 16, 2), // "E"
            decimalScale: signedInt(view, s, 18, 2),// "D"
            bitsPerValue: u8(view, s, 20)
        };

        if (recipe.template === 2 || recipe.template === 3) {
            recipe.missingValueManagement = u8(view, s, 23);   // 0 = none, 1 / 2 = "all ones" means missing
            recipe.groupCount = u32(view, s, 32);              // number of groups
            recipe.widthReference = u8(view, s, 36);           // base for the groups' bit widths
            recipe.widthBits = u8(view, s, 37);                // bits used to store each width
            recipe.lengthReference = u32(view, s, 38);         // base for the groups' lengths
            recipe.lengthIncrement = u8(view, s, 42);          // multiplier for stored lengths
            recipe.lastGroupLength = u32(view, s, 43);         // exact length of the final group
            recipe.lengthBits = u8(view, s, 47);               // bits used to store each length
            if (recipe.template === 3) {
                recipe.differencingOrder = u8(view, s, 48);    // 1 or 2 (see undoSpatialDifferencing)
                recipe.extraDescriptorBytes = u8(view, s, 49); // size of the header numbers
            } else {
                recipe.differencingOrder = 0;
                recipe.extraDescriptorBytes = 0;
            }
        }
        return recipe;
    }

    // ------------------------------------------------------------------
    // Section 7 — turning the packed bytes into one value per grid point
    // ------------------------------------------------------------------

    /**
     * @param {Uint8Array} bytes   the whole message
     * @param {number} dataStart   byte index where the packed numbers begin
     * @param {number} dataEnd     byte index just past the end of Section 7
     * @param {object} recipe      from parseDataRepresentationSection
     * @param {object|null} bitmap from Section 6, or null if every grid point has a value
     * @param {number} numPoints   total grid points (ni * nj)
     */
    function decodeValues(bytes, dataStart, dataEnd, recipe, bitmap, numPoints) {
        let values;
        if (recipe.template === 0) {
            values = parts.unpack.unpackSimple(bytes, dataStart, recipe);
        } else if (recipe.template === 2 || recipe.template === 3) {
            values = parts.unpack.unpackComplex(bytes, dataStart, dataEnd, recipe);
        } else {
            throw new Error("Unsupported GRIB2 data representation template 5." + recipe.template +
                (recipe.template === 40 ? " (JPEG2000)" : recipe.template === 41 ? " (PNG)" : "") +
                ". Only simple and complex packing (5.0, 5.2, 5.3) are supported.");
        }

        // BITMAP: a list with one bit per grid point. 1 = this point has a value (taken, in
        // order, from the packed list), 0 = no data (we store NaN). Used e.g. for ocean-only
        // fields, where land points are skipped.
        if (bitmap && bitmap.indicator === 0) {
            const spread = new Float32Array(numPoints).fill(NaN);
            let next = 0; // index into the packed list
            for (let i = 0; i < numPoints && next < values.length; i++) {
                const hasValue = (bytes[bitmap.offset + (i >> 3)] >> (7 - (i & 7))) & 1;
                if (hasValue) spread[i] = values[next++];
            }
            return spread;
        }

        if (values.length !== numPoints) throw new Error("GRIB2 value count does not match grid size.");
        return values;
    }

    // ------------------------------------------------------------------
    // Walking through one message
    // ------------------------------------------------------------------

    /**
     * Parse one GRIB2 message.
     *
     * @param {Uint8Array} bytes   exactly one message (starting with "GRIB")
     * @param {(meta: object) => boolean} [wanted]
     *        Called with the field's metadata BEFORE its values are decoded. Return false to
     *        skip it. Decoding is the expensive part (~0.1 s per field), so skipping the
     *        ~700 fields we do not care about is what makes this practical.
     * @returns {object[]} fields, in the shape described at the top of this file
     */
    function parseMessage(bytes, wanted) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        // ---- Section 0: the 16-byte indicator ----
        if (bytes.length < 16 || u32(view, 0, 1) !== MAGIC_GRIB) {
            throw new Error("Not a GRIB2 message (the URL may return an HTML error page or another format).");
        }
        const discipline = u8(view, 0, 7);
        const edition = u8(view, 0, 8);
        if (edition !== 2) throw new Error("Only GRIB edition 2 is supported (found edition " + edition + ").");
        const messageLength = Math.min(u64(view, 0, 9), bytes.length);

        // ---- Sections 1..8: remember the latest of each kind, emit a field at every Section 7 ----
        const fields = [];
        let identification = null, grid = null, product = null, recipe = null, bitmap = null;

        let s = 16; // byte index where the current section starts (Section 0 is exactly 16 bytes)
        while (s + 5 <= messageLength) {
            if (view.getUint32(s) === MAGIC_7777) break;      // Section 8: end marker

            const sectionLength = u32(view, s, 1);
            const sectionNumber = u8(view, s, 5);
            if (sectionLength < 5) throw new Error("Corrupt GRIB2 section length.");

            if (sectionNumber === 1) {
                identification = parseIdentificationSection(view, s);
            } else if (sectionNumber === 3) {
                grid = parseGridSection(view, s);
            } else if (sectionNumber === 4) {
                product = parseProductSection(view, s, identification);
            } else if (sectionNumber === 5) {
                recipe = parseDataRepresentationSection(view, s);
            } else if (sectionNumber === 6) {
                // Octet 6 is the bitmap indicator: 0 = a bitmap follows, 254 = reuse the previous
                // one, 255 = no bitmap (every point has data).
                const indicator = u8(view, s, 6);
                if (indicator === 0) bitmap = { indicator: 0, offset: s + 6 };   // bits start at octet 7
                else if (indicator === 255) bitmap = null;
            } else if (sectionNumber === 7 && grid && product && recipe) {
                // All the information for one field is now known.
                const field = Object.assign({ discipline }, product);
                if (!wanted || wanted(field)) {
                    field.grid = grid;
                    // The packed numbers start at octet 6 of Section 7.
                    field.values = decodeValues(bytes, s + 5, s + sectionLength, recipe, bitmap, grid.numPoints);
                    fields.push(field);
                }
            }

            s += sectionLength; // jump to the next section
        }
        return fields;
    }

    /** Does this byte array start with the letters "GRIB"? */
    function isGribHeader(bytes) {
        return bytes.length >= 4 &&
            ((bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0) === MAGIC_GRIB;
    }

    /** Total length of the message that starts at bytes[0] (Section 0, octets 9-16). */
    function messageLength(bytes) {
        return u64(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, 9);
    }

    parts.grib2 = { parseMessage, isGribHeader, messageLength };
})(globalThis);
