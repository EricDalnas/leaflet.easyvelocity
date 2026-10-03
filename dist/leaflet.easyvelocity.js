/*! leaflet.easyvelocity v0.1.0 | Proprietary, all rights reserved. See LICENSE. */
/* Built from src/ by tools/build-dist.js: edit the files in src/, not this file. */

/* ===== src/grib2-unpack.js ===== */
/*
 * grib2-unpack.js — turning packed bits back into real numbers
 * =============================================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript: no Leaflet, no DOM, no network.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A weather grid such as NOAA GFS 0.25 degrees has 1440 x 721 = about one million points
 * per variable. Storing each point as a 32-bit float would cost ~4 MB per variable, so GRIB2
 * "packs" the numbers: every value is stored as a small unsigned integer X (often 8-16 bits)
 * together with a short "recipe" that converts X back into a physical value
 * (here: metres per second). This file undoes that packing.
 *
 * THE RECIPE (read from GRIB2 "Section 5" by grib2-reader.js)
 * -----------------------------------------------------------
 *   referenceValue (R)  the starting value, roughly the minimum of the field
 *   binaryScale    (E)  a power-of-two scale factor
 *   decimalScale   (D)  a power-of-ten scale factor
 *   bitsPerValue        how many bits each stored integer X occupies
 *
 *   physical value = (R + X * 2^E) / 10^D
 *
 *   Worked example:  R = -30, E = -6, D = 0, stored X = 3840
 *     value = (-30 + 3840 * 2^-6) / 10^0 = -30 + 60 = 30
 *   The encoder chooses E and D so that the rounding error is far smaller than the
 *   measurement accuracy, which is why this "lossy" packing is acceptable.
 *
 * TWO PACKING STYLES ARE SUPPORTED ("data representation templates")
 * ------------------------------------------------------------------
 *   Template 5.0  SIMPLE packing. Every value uses the same number of bits.
 *   Template 5.2  COMPLEX packing. Values are cut into GROUPS (runs of neighbouring points).
 *                 Each group stores its own minimum and bit width, so calm / smooth regions
 *                 need very few bits.
 *   Template 5.3  COMPLEX packing + SPATIAL DIFFERENCING. Like 5.2, but the encoder first
 *                 replaces the values by their differences from the previous point, which
 *                 are smaller numbers and pack even better. NOAA GFS uses 5.3.
 *
 *   Not supported: 5.40 (JPEG 2000), 5.41 (PNG), 5.42 (CCSDS). Those need real image / entropy
 *   decoders; see the "decoder contract" at the bottom of grib2-reader.js if you want to plug a
 *   library in.
 *
 * Public surface (see the bottom of the file): BitReader, decodeSignMagnitude,
 * unpackSimple, unpackComplex.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    // ------------------------------------------------------------------
    // Small building blocks
    // ------------------------------------------------------------------

    /**
     * GRIB2 stores signed integers in SIGN-MAGNITUDE form, not two's complement:
     * the highest bit is a sign flag (1 = negative) and the remaining bits are the size.
     *
     *   8-bit examples:  0000 0101 -> +5     1000 0101 -> -5     1000 0000 -> -0 (= 0)
     *
     * @param {number} raw       the unsigned integer that was read from the file
     * @param {number} bitCount  how many bits the field occupies (8, 16, 32, ...)
     */
    function decodeSignMagnitude(raw, bitCount) {
        const signBit = Math.pow(2, bitCount - 1);
        return raw >= signBit ? -(raw - signBit) : raw;
    }

    /**
     * Reads unsigned integers of ANY bit width (1, 7, 13, ... up to 32) from a byte array.
     *
     * Packed data does not respect byte boundaries. Ten-bit values, for example, are written
     * back to back, so value #1 starts in the middle of byte #1. GRIB2 packs bits
     * "most significant bit first", i.e. the same way we write binary numbers on paper.
     *
     *   bytes:  10110010 01101101 ...
     *   read(3) -> 101   (= 5)     read(10) -> 1001001101   (= 589, spans the two bytes)
     */
    class BitReader {
        /**
         * @param {Uint8Array} bytes
         * @param {number} startByte  index of the first byte to read from
         */
        constructor(bytes, startByte) {
            this.bytes = bytes;
            this.bitPos = startByte * 8; // absolute position, in bits, of the next bit to read
        }

        /** Read the next `bitCount` bits as an unsigned integer. read(0) returns 0. */
        read(bitCount) {
            if (bitCount === 0) return 0;
            const bytes = this.bytes;
            let pos = this.bitPos;
            let value = 0;
            let remaining = bitCount;
            while (remaining > 0) {
                // Take as many bits as are left in the current byte (or as many as we still need).
                const bitsLeftInByte = 8 - (pos & 7);
                const take = remaining < bitsLeftInByte ? remaining : bitsLeftInByte;
                // Shift the wanted bits down to the bottom of the byte and mask off the rest.
                const chunk = (bytes[pos >> 3] >> (bitsLeftInByte - take)) & ((1 << take) - 1);
                // Append them to the result. (Multiplying instead of `<<` stays correct above 31 bits.)
                value = value * (1 << take) + chunk;
                pos += take;
                remaining -= take;
            }
            this.bitPos = pos;
            return value;
        }

        /** Skip ahead to the next whole-byte boundary (complex packing pads between its tables). */
        alignToByte() {
            this.bitPos = Math.ceil(this.bitPos / 8) * 8;
        }
    }

    /** The formula from the top of this file: stored integer X -> physical value. */
    function makeScaler(recipe) {
        const binaryFactor = Math.pow(2, recipe.binaryScale);
        const decimalFactor = Math.pow(10, -recipe.decimalScale);
        return (x) => (recipe.referenceValue + x * binaryFactor) * decimalFactor;
    }

    // ------------------------------------------------------------------
    // Template 5.0 — simple packing
    // ------------------------------------------------------------------

    /**
     * @param {Uint8Array} bytes
     * @param {number} dataStart  byte index where the packed numbers begin (Section 7 payload)
     * @param {object} recipe     parsed Section 5 (see grib2-reader.js)
     * @returns {Float32Array}    one physical value per stored integer
     */
    function unpackSimple(bytes, dataStart, recipe) {
        const out = new Float32Array(recipe.numValues);
        const toValue = makeScaler(recipe);

        // bitsPerValue === 0 is the encoder's shortcut for "all values are identical (= R)".
        if (recipe.bitsPerValue === 0) {
            out.fill(toValue(0));
            return out;
        }

        const reader = new BitReader(bytes, dataStart);
        for (let i = 0; i < out.length; i++) {
            out[i] = toValue(reader.read(recipe.bitsPerValue));
        }
        return out;
    }

    // ------------------------------------------------------------------
    // Templates 5.2 / 5.3 — complex packing
    // ------------------------------------------------------------------
    //
    // Layout of the packed bytes (Section 7), in order:
    //
    //   [5.3 only] spatial-differencing header: starting value(s) + a "minimum difference"
    //   [group references]  one number per group
    //   [group widths]      one number per group
    //   [group lengths]     one number per group
    //   [the values]        every group's values, back to back, each `width` bits wide
    //
    // Each of the three per-group tables is padded to a whole byte (alignToByte).
    //
    // A group is a run of consecutive grid points that are stored with the same bit width:
    //   stored integer for point = group reference + (width-bit number read from the data)

    /**
     * Template 5.3 prefix: the values needed to undo spatial differencing (explained in
     * undoSpatialDifferencing below). Returns null for template 5.2, which has none.
     */
    function readDifferencingHeader(reader, recipe) {
        if (recipe.template !== 3) return null;
        if (recipe.extraDescriptorBytes > 4) {
            throw new Error("Unsupported GRIB2 spatial differencing descriptor size.");
        }
        const bits = recipe.extraDescriptorBytes * 8;
        const firstValue = reader.read(bits);
        // Second-order differencing needs two starting values, first-order only one.
        const secondValue = recipe.differencingOrder === 2 ? reader.read(bits) : 0;
        // The smallest difference, stored sign-magnitude (see decodeSignMagnitude).
        const minimumDifference = decodeSignMagnitude(reader.read(bits), bits);
        return { firstValue, secondValue, minimumDifference, order: recipe.differencingOrder };
    }

    /** Read the three per-group tables (reference, bit width, length). */
    function readGroupTables(reader, recipe) {
        const groupCount = recipe.groupCount;

        // (a) The "reference" of each group: the lowest stored integer in that group.
        const references = new Float64Array(groupCount);
        for (let g = 0; g < groupCount; g++) references[g] = reader.read(recipe.bitsPerValue);
        reader.alignToByte();

        // (b) How many bits each value of the group uses. Stored as an offset from a common base.
        const widths = new Uint8Array(groupCount);
        for (let g = 0; g < groupCount; g++) {
            widths[g] = recipe.widthReference + reader.read(recipe.widthBits);
        }
        reader.alignToByte();

        // (c) How many values are in each group: base + stored * increment. The very last
        //     group is special: its true length is given directly in the recipe.
        const lengths = new Uint32Array(groupCount);
        for (let g = 0; g < groupCount; g++) {
            lengths[g] = recipe.lengthReference + reader.read(recipe.lengthBits) * recipe.lengthIncrement;
        }
        if (groupCount > 0) lengths[groupCount - 1] = recipe.lastGroupLength;
        reader.alignToByte();

        return { references, widths, lengths };
    }

    /**
     * Read every group's values and turn them into integers (still "packed" integers, not yet
     * physical units).
     *
     * MISSING VALUES: when the recipe's missingValueManagement is 1 or 2, the all-ones bit
     * pattern (e.g. 1111 1111 in an 8-bit group) means "no data here". With management 2 the
     * pattern one below that is a second kind of "missing". A group whose width is 0 stores no
     * bits at all, its reference alone says whether the whole group is missing.
     *
     * @returns {{ints: Float64Array, missing: Uint8Array|null}}
     */
    function readGroupedIntegers(reader, recipe, tables) {
        const { references, widths, lengths } = tables;
        const count = recipe.numValues;

        // Sanity check: the group lengths must add up to the number of values we expect.
        let total = 0;
        for (let g = 0; g < recipe.groupCount; g++) total += lengths[g];
        if (total !== count) {
            throw new Error("Corrupt GRIB2 data section (group lengths do not match value count).");
        }

        const ints = new Float64Array(count);
        const missing = recipe.missingValueManagement ? new Uint8Array(count) : null;
        const allOnesForReference = recipe.bitsPerValue > 0 ? Math.pow(2, recipe.bitsPerValue) - 1 : -1;
        const hasSecondaryMissing = recipe.missingValueManagement === 2;

        let k = 0; // index of the next value to fill
        for (let g = 0; g < recipe.groupCount; g++) {
            const width = widths[g];
            const length = lengths[g];
            const reference = references[g];

            if (width === 0) {
                // Constant group: every value equals the reference (or all are missing).
                const allMissing = missing && (reference === allOnesForReference ||
                    (hasSecondaryMissing && reference === allOnesForReference - 1));
                for (let i = 0; i < length; i++, k++) {
                    if (allMissing) missing[k] = 1; else ints[k] = reference;
                }
            } else {
                const allOnes = Math.pow(2, width) - 1;
                for (let i = 0; i < length; i++, k++) {
                    const stored = reader.read(width);
                    if (missing && (stored === allOnes || (hasSecondaryMissing && stored === allOnes - 1))) {
                        missing[k] = 1;
                    } else {
                        ints[k] = reference + stored;
                    }
                }
            }
        }
        return { ints, missing };
    }

    /**
     * SPATIAL DIFFERENCING (template 5.3), and how to undo it.
     *
     * Neighbouring grid points usually have similar values, so the DIFFERENCES between
     * neighbours are small numbers that pack into fewer bits than the values themselves.
     *
     *   original values      100  103  107  110  112
     *   first differences    (100)  +3   +4   +3   +2     <- what the encoder works with
     *
     * Differences can be negative, but packed integers cannot. So the encoder subtracts the
     * smallest difference ("minimumDifference") from all of them, making them non-negative.
     * To decode we reverse each step:
     *
     *   FIRST ORDER   value[n] = stored[n] + minimumDifference + value[n-1]
     *                 (value[0] is the "firstValue" from the header)
     *
     *   SECOND ORDER  differences of differences, used for very smooth fields:
     *                 value[n] = stored[n] + minimumDifference + 2*value[n-1] - value[n-2]
     *                 (value[0] and value[1] come from the header)
     *
     * Missing values are skipped: the arithmetic runs over the points that have data.
     * The array is modified in place.
     */
    function undoSpatialDifferencing(ints, missing, header) {
        const { firstValue, secondValue, minimumDifference, order } = header;
        let seen = 0;     // how many real (non-missing) values have been rebuilt so far
        let prev1 = 0;    // value[n-1]
        let prev2 = 0;    // value[n-2]
        for (let i = 0; i < ints.length; i++) {
            if (missing && missing[i]) continue;
            let value;
            if (seen === 0) {
                value = firstValue;
            } else if (seen === 1 && order === 2) {
                value = secondValue;
            } else {
                value = ints[i] + minimumDifference;
                value = order === 1 ? value + prev1 : value + 2 * prev1 - prev2;
            }
            prev2 = prev1;
            prev1 = value;
            ints[i] = value;
            seen++;
        }
    }

    /**
     * @param {Uint8Array} bytes
     * @param {number} dataStart  byte index where the packed numbers begin
     * @param {number} dataEnd    byte index just past the end of this section (for a sanity check)
     * @param {object} recipe     parsed Section 5
     * @returns {Float32Array}
     */
    function unpackComplex(bytes, dataStart, dataEnd, recipe) {
        const reader = new BitReader(bytes, dataStart);

        const differencing = readDifferencingHeader(reader, recipe);   // 5.3 only
        const tables = readGroupTables(reader, recipe);
        const { ints, missing } = readGroupedIntegers(reader, recipe, tables);

        if (reader.bitPos > dataEnd * 8) throw new Error("Truncated GRIB2 data section.");

        if (differencing && differencing.order > 0) undoSpatialDifferencing(ints, missing, differencing);

        // Finally apply the recipe formula to every integer (missing -> NaN).
        const toValue = makeScaler(recipe);
        const out = new Float32Array(ints.length);
        for (let i = 0; i < ints.length; i++) {
            out[i] = missing && missing[i] ? NaN : toValue(ints[i]);
        }
        return out;
    }

    parts.unpack = { BitReader, decodeSignMagnitude, unpackSimple, unpackComplex };
})(globalThis);

/* ===== src/grib2-reader.js ===== */
/*
 * grib2-reader.js — a minimal GRIB2 file reader
 * ==============================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript: no Leaflet, no DOM, no network.
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

/* ===== src/wind-data.js ===== */
/*
 * wind-data.js — a wind grid you can ask "what is the wind at this latitude/longitude?"
 * ===================================================================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript: no Leaflet, no DOM, no network.
 *
 * This is the one data structure shared by BOTH halves of the plugin:
 *   - the loaders (grib-loader.js, test-field.js) BUILD a WindData from whatever source they read;
 *   - the Leaflet layer (leaflet.easyvelocity.js and friends) only ever ASKS a WindData for wind vectors.
 * Because of that, the drawing code never needs to know whether the numbers came from a
 * GRIB2 file, a test generator, or something added in the future (e.g. NetCDF).
 *
 * WHAT IS STORED
 * --------------
 * A regular latitude/longitude grid with two values per point, U and V:
 *   u  how fast the air moves towards the EAST  (m/s)   negative = towards the west
 *   v  how fast the air moves towards the NORTH (m/s)   negative = towards the south
 * Wind SPEED is sqrt(u*u + v*v). The direction the wind blows TOWARDS follows from atan2(u, v).
 * (Meteorologists name a wind by where it comes FROM, which is 180 degrees opposite.)
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

    class WindData {
        /**
         * @param {object} g
         * @param {number} g.lat0  latitude of the first row
         * @param {number} g.lon0  longitude of the first column
         * @param {number} g.dx    longitude step between columns, degrees (negative = westwards)
         * @param {number} g.dy    latitude step between rows, degrees (negative = southwards)
         * @param {number} g.ni    number of columns
         * @param {number} g.nj    number of rows
         * @param {Float32Array} g.u  east-ward wind, length ni * nj
         * @param {Float32Array} g.v  north-ward wind, length ni * nj
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
         * Bilinear interpolation of the wind at any latitude/longitude.
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

    parts.WindData = WindData;
})(globalThis);

/* ===== src/test-field.js ===== */
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

/* ===== src/grib-loader.js ===== */
/*
 * grib-loader.js — getting wind data from a URL into a WindData
 * ==============================================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript apart from fetch(). Needs grib2-reader.js,
 * wind-data.js and test-field.js.
 *
 * THE JOB
 * -------
 *   loadSource("https://.../gfs.t00z.pgrb2.0p25.f000", options)   ->  Promise<WindData>
 *   loadSource("test", options)                                     ->  Promise<WindData>
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
        return new parts.WindData({
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
     * @param {string|WindData} source  "test", a GRIB2 URL, or an already built WindData
     * @param {object} options
     *        level, levelType   which wind to pick (default 10 m above ground = 10, 103)
     *        hours              (test source only) hours since the first time shown
     *        signal             AbortSignal to cancel the download
     *        onProgress(bytes)  called while streaming
     *        fetchOptions       extra fetch() options (e.g. credentials), streaming strategy only
     * @returns {Promise<WindData>}
     */
    async function loadSource(source, options) {
        if (source instanceof parts.WindData) return source;
        if (typeof source !== "string" || !source.trim()) throw new Error("No data source specified.");
        if (source === "test") return parts.createTestField(options.hours);
        return loadGrib2(source.trim(), options);
    }

    parts.isAbortError = isAbortError;
    parts.loadSource = loadSource;
})(globalThis);

/* ===== src/time-sources.js ===== */
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

/* ===== src/gfs.js ===== */
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

/* ===== src/frame-cache.js ===== */
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

/* ===== src/speed-field.js ===== */
/*
 * speed-field.js — the coloured wind-speed background, and the screen-aligned wind grid
 * ======================================================================================
 *
 * Part of leaflet.easyvelocity. This file is a MIXIN for the L.EasyVelocity layer: its methods are
 * mixed in by leaflet.easyvelocity.js and `this` is the layer. Needs Leaflet.
 *
 * TWO COORDINATE WORLDS
 * ---------------------
 *   geographic   latitude/longitude. The WindData lives here.
 *   canvas       pixels of the layer's own <canvas>, origin at its top-left corner. Drawing,
 *                and the particles' positions, live here.
 *
 * Converting between them for every particle on every animation frame would be slow, so instead
 * we do it ONCE whenever the map view changes (_rebuildField):
 *
 *      for a coarse grid of canvas pixels (every `fieldResolution` px, default 4 px):
 *          convert the pixel to latitude/longitude        <- Leaflet does this
 *          ask WindData for the wind there                 <- bilinear interpolation
 *          store it in a small array (this._gu / this._gv, "u" and "v" per grid cell)
 *
 * The result is a "screen grid": a picture of the wind field in canvas pixels. Everything
 * after that is cheap:
 *   - the colour field is just that grid painted as an image (_drawField), and
 *   - each particle looks up its wind in the same grid (see particles.js).
 *
 * When does this run? On every moveend / zoom / resize / new data. NOT while dragging (the
 * canvas simply moves with the map pane), and never involving a download.
 *
 * COLOUR SCALE
 * ------------
 * `colorScale` is a list of [speed in m/s, CSS colour] stops. Speeds in between are blended
 * linearly. For speed we precompute a 256-entry lookup table (LUT) from slowest to fastest, so
 * painting a cell is one array lookup instead of colour maths.
 */
(function (root) {
    "use strict";

    const L = root.L;
    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    // Default scale in m/s: blue (calm) -> green -> yellow -> orange -> red -> purple (storm).
    parts.defaultColorScale = [
        [0, "#264b96"], [3, "#2f8ed1"], [6, "#2fc2a8"], [9, "#6fd05c"], [12, "#d3df3a"],
        [16, "#f7b52c"], [20, "#f26b21"], [25, "#d62839"], [32, "#8a1c7c"]
    ];

    /**
     * Turn [[value, cssColor], ...] into [{value, color, r, g, b}, ...] sorted by value.
     * The browser does the colour parsing for us: paint one pixel with the CSS colour on a
     * 1x1 canvas and read the red/green/blue back. That accepts "#abc", "rgb(...)", "red", ...
     */
    function parseColorStops(stops) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        return stops.map((stop) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = "#000";          // fallback if the CSS colour is invalid
            ctx.fillStyle = stop[1];
            ctx.fillRect(0, 0, 1, 1);
            const px = ctx.getImageData(0, 0, 1, 1).data;
            return { value: stop[0], color: stop[1], r: px[0], g: px[1], b: px[2] };
        }).sort((a, b) => a.value - b.value);
    }

    parts.speedField = {

        /** The colour scale, for building a legend: { units, min, max, stops: [{value, color}] }. */
        getLegend: function () {
            const stops = this._stops;
            return {
                units: "m/s",
                min: stops[0].value,
                max: stops[stops.length - 1].value,
                stops: stops.map((s) => ({ value: s.value, color: s.color }))
            };
        },

        /** Build the 256-colour lookup table from the `colorScale` option. */
        _buildLut: function () {
            const scale = this.options.colorScale && this.options.colorScale.length > 1
                ? this.options.colorScale
                : parts.defaultColorScale;
            const stops = this._stops = parseColorStops(scale);
            const min = this._lutMin = stops[0].value;
            const max = stops[stops.length - 1].value;
            this._lutScale = 255 / Math.max(1e-9, max - min);   // speed -> LUT index multiplier

            const lut = this._lut = new Uint8ClampedArray(256 * 3);   // r, g, b per entry
            let s = 0; // index of the stop at the lower end of the current segment
            for (let i = 0; i < 256; i++) {
                const speed = min + (i / 255) * (max - min);
                while (s < stops.length - 2 && speed > stops[s + 1].value) s++;
                const a = stops[s];
                const b = stops[s + 1];
                // How far between the two stops are we? 0..1
                const t = b.value === a.value ? 0 : Math.min(1, Math.max(0, (speed - a.value) / (b.value - a.value)));
                lut[i * 3] = a.r + (b.r - a.r) * t;
                lut[i * 3 + 1] = a.g + (b.g - a.g) * t;
                lut[i * 3 + 2] = a.b + (b.b - a.b) * t;
            }
        },

        /**
         * "The screen grid is out of date, rebuild it soon." Several events can arrive in one
         * burst (viewreset + moveend, ...), so the rebuild is scheduled for the next animation
         * frame and duplicates are ignored. Until then the particles pause (_gridReady = false).
         */
        _invalidateField: function () {
            this._gridReady = false;
            if (this._rebuildHandle) return;
            this._rebuildHandle = requestAnimationFrame(() => {
                this._rebuildHandle = 0;
                this._rebuildField();
            });
        },

        /**
         * Sample the cached WindData onto the screen grid (see the top of this file), then
         * repaint the colour field.
         *
         * Grid cell (i, j) corresponds to canvas pixel (i * cell, j * cell), where `cell` is
         * the resolution in canvas pixels. Its u/v end up in this._gu[j * gridWidth + i].
         */
        _rebuildField: function () {
            if (!this._map || !this._wrap) return;
            const canvasW = this._cw;
            const canvasH = this._ch;
            const data = this._data;

            if (!data) {
                // Nothing loaded (yet, or an error): show an empty layer.
                this._gridReady = false;
                this._fctx.clearRect(0, 0, canvasW, canvasH);
                this._pctx.clearRect(0, 0, canvasW, canvasH);
                return;
            }

            const ratio = this._ratio;                                        // canvas px per CSS px
            const cell = Math.max(1, this.options.fieldResolution) * ratio;    // grid spacing in canvas px
            const gridW = Math.ceil(canvasW / cell) + 1;                       // +1: a cell on each edge
            const gridH = Math.ceil(canvasH / cell) + 1;
            if (!this._gu || this._gu.length !== gridW * gridH) {
                this._gu = new Float32Array(gridW * gridH);
                this._gv = new Float32Array(gridW * gridH);
            }
            this._gw = gridW;
            this._gh = gridH;
            this._cell = cell;

            const gu = this._gu;
            const gv = this._gv;
            const tmp = this._tmp;
            const map = this._map;
            const origin = this._origin;     // where the canvas's top-left corner is, in Leaflet "layer points"
            const stepCss = cell / ratio;    // grid spacing in CSS pixels (Leaflet works in CSS pixels)

            // SPEED-UP for the standard map projection (Web Mercator, EPSG:3857): there, longitude
            // depends only on the x pixel and latitude only on the y pixel. So instead of one
            // conversion per grid cell we do one per column plus one per row.
            const separable = map.options.crs === L.CRS.EPSG3857;
            const lons = new Float64Array(gridW);
            const lats = new Float64Array(gridH);
            if (separable) {
                for (let i = 0; i < gridW; i++) {
                    lons[i] = map.layerPointToLatLng(L.point(origin.x + i * stepCss, origin.y)).lng;
                }
                for (let j = 0; j < gridH; j++) {
                    lats[j] = map.layerPointToLatLng(L.point(origin.x, origin.y + j * stepCss)).lat;
                }
            }

            for (let j = 0; j < gridH; j++) {
                for (let i = 0; i < gridW; i++) {
                    let lat, lon;
                    if (separable) {
                        lat = lats[j];
                        lon = lons[i];
                    } else {
                        // Other projections: convert every cell individually (slower but general).
                        const ll = map.layerPointToLatLng(L.point(origin.x + i * stepCss, origin.y + j * stepCss));
                        lat = ll.lat;
                        lon = ll.lng;
                    }
                    const k = j * gridW + i;
                    if (data.sample(lat, lon, tmp)) {
                        gu[k] = tmp[0];
                        gv[k] = tmp[1];
                    } else {
                        gu[k] = NaN;   // no data here (outside the grid, or a hole in it)
                        gv[k] = NaN;
                    }
                }
            }

            this._gridReady = true;
            this._drawField();
            if (this._needRespawn) this._initParticles();
        },

        /**
         * Paint the colour field.
         *
         * Trick: instead of colouring millions of canvas pixels, make a tiny image with ONE
         * pixel per screen-grid cell (a few hundred by a few hundred), colour those, and let the
         * browser stretch it over the canvas with smooth (bilinear) scaling. That gives a
         * continuous colour field for almost no CPU cost.
         */
        _drawField: function () {
            const gridW = this._gw;
            const gridH = this._gh;
            const gu = this._gu;
            const gv = this._gv;

            // A small off-screen canvas that holds the one-pixel-per-cell picture.
            if (!this._speedImg) this._speedImg = document.createElement("canvas");
            const small = this._speedImg;
            if (small.width !== gridW) small.width = gridW;
            if (small.height !== gridH) small.height = gridH;
            const smallCtx = small.getContext("2d");
            const image = smallCtx.createImageData(gridW, gridH);
            const rgba = image.data;                    // 4 bytes per pixel: red, green, blue, alpha

            const lut = this._lut;
            const lutMin = this._lutMin;
            const lutScale = this._lutScale;
            for (let k = 0, n = gridW * gridH; k < n; k++) {
                const u = gu[k];
                const v = gv[k];
                if (u !== u || v !== v) continue;       // NaN = no data: leave the pixel transparent
                const speed = Math.sqrt(u * u + v * v);
                let index = ((speed - lutMin) * lutScale) | 0;           // speed -> 0..255
                index = index < 0 ? 0 : index > 255 ? 255 : index;       // clamp
                const p = k * 4;
                const c = index * 3;
                rgba[p] = lut[c];
                rgba[p + 1] = lut[c + 1];
                rgba[p + 2] = lut[c + 2];
                rgba[p + 3] = 255;
            }
            smallCtx.putImageData(image, 0, 0);

            // Stretch it over the real canvas. Cell (i, j) is CENTRED on canvas pixel
            // (i * cell, j * cell), hence the half-cell shift.
            const ctx = this._fctx;
            const cell = this._cell;
            ctx.clearRect(0, 0, this._cw, this._ch);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(small, -cell / 2, -cell / 2, gridW * cell, gridH * cell);
        }
    };
})(globalThis);

/* ===== src/particles.js ===== */
/*
 * particles.js — the animated wind particles
 * ===========================================
 *
 * Part of leaflet.easyvelocity. This file is a MIXIN for the L.EasyVelocity layer: its methods are
 * mixed in by leaflet.easyvelocity.js and `this` is the layer.
 *
 * HOW THE ANIMATION WORKS
 * -----------------------
 * Thousands of tiny "particles" are placed at random positions. Every animation frame
 * (about 60 times a second) each particle:
 *   1. looks up the wind at its position in the screen grid built by speed-field.js,
 *   2. moves a little way in that direction,
 *   3. draws a short line from its old to its new position.
 * Lines from previous frames are faded out a little each frame instead of erased, which
 * produces the flowing "trails". After `particleMaxAge` frames a particle is reborn at a new
 * random position, so the picture stays evenly covered.
 *
 *      frame n                 frame n+1
 *        o  ->  wind  ->         o          the line drawn between the two positions is one
 *      (x, y)               (x + dx, y + dy)   small piece of a trail
 *
 * PERFORMANCE: thousands of particles, 60 frames a second, so
 *   - particle state lives in typed arrays (one Float32Array per coordinate), not objects:
 *     no allocation, no garbage collection in the loop;
 *   - ALL the line segments of a frame are added to ONE path and stroked with ONE call.
 *
 * PARTICLE STATE (arrays indexed by particle number i)
 *   _px[i], _py[i]   position in canvas pixels
 *   _age[i]          frames lived so far; -1 means "dormant": waiting for a place with data
 *   _maxAge[i]       lifetime in frames (randomised so they do not all die at once)
 *
 * WIND DIRECTION ON SCREEN
 *   u (east)  increases x (moves right)
 *   v (north) DEcreases y (screen y grows downwards)       so:  dy = -v * scale
 *
 * MISSING DATA: if the wind under a particle is NaN (outside the data, or a hole), the
 * particle becomes dormant, then respawns somewhere that has data. That is the
 * "disappears and reappears" behaviour.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    parts.particles = {

        // ---- start / stop -------------------------------------------------

        /** Start (or resume) the animation. Frozen frames keep their trails. */
        start: function () {
            this._wantRunning = true;
            this._schedule();
            this.fire("start");
            return this;
        },

        stop: function () {
            this._wantRunning = false;
            this._cancelFrame();
            this.fire("stop");
            return this;
        },

        isRunning: function () { return this._wantRunning; },

        // ---- setting particles up ----------------------------------------

        /** (Re)create the typed arrays for `particleCount` particles. */
        _allocParticles: function () {
            const n = Math.max(0, this.options.particleCount | 0);
            this._px = new Float32Array(n);
            this._py = new Float32Array(n);
            this._age = new Int16Array(n);
            this._maxAge = new Uint16Array(n);
            this._needRespawn = true;
        },

        /**
         * Put particle i at a random canvas position that has wind data.
         * Tries 8 random spots; if none has data the particle goes dormant (age = -1) and is
         * retried on the next frame.
         * @returns {boolean} true if it was placed
         */
        _spawn: function (i) {
            const canvasW = this._cw;
            const canvasH = this._ch;
            const gu = this._gu;
            const gridW = this._gw;
            const toGrid = 1 / this._cell;          // canvas pixels -> screen-grid cells

            for (let attempt = 0; attempt < 8; attempt++) {
                const x = Math.random() * (canvasW - 1);
                const y = Math.random() * (canvasH - 1);
                const gridIndex = Math.round(y * toGrid) * gridW + Math.round(x * toGrid);
                if (gu[gridIndex] === gu[gridIndex]) {          // not NaN: there is wind data here
                    this._px[i] = x;
                    this._py[i] = y;
                    this._age[i] = 0;
                    this._maxAge[i] = this.options.particleMaxAge * (0.6 + 0.8 * Math.random());
                    return true;
                }
            }
            this._age[i] = -1;
            return false;
        },

        /** Scatter all particles, with random ages so they do not all expire in the same frame. */
        _initParticles: function () {
            this._needRespawn = false;
            const n = this._px.length;
            for (let i = 0; i < n; i++) {
                if (this._spawn(i)) this._age[i] = (Math.random() * this._maxAge[i]) | 0;
            }
            if (this._pctx) this._pctx.clearRect(0, 0, this._cw, this._ch);
        },

        // ---- the animation loop ------------------------------------------

        _schedule: function () {
            if (this._map && this._wantRunning && !this._raf) {
                this._raf = requestAnimationFrame(this._tick);
            }
        },

        _cancelFrame: function () {
            if (this._raf) {
                cancelAnimationFrame(this._raf);
                this._raf = 0;
            }
        },

        // requestAnimationFrame calls this once per screen refresh (and pauses in hidden tabs).
        _tick: function () {
            this._raf = requestAnimationFrame(this._tick);
            this._step();
        },

        /** Advance every particle by one frame and draw it. */
        _step: function () {
            const o = this.options;
            if (!o.showParticles || !this._gridReady || !this._pctx) return;
            const ctx = this._pctx;

            // ---- 1. fade the previous frames (this makes the trails) ----
            // "destination-in" keeps the existing pixels but multiplies their opacity by the fill
            // colour's alpha. With trailLength 0.9, a pixel keeps 90% of its opacity per frame.
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "destination-in";
            ctx.fillStyle = "rgba(0,0,0," + Math.min(1, Math.max(0, o.trailLength)) + ")";
            ctx.fillRect(0, 0, this._cw, this._ch);

            // ---- 2. set up for drawing the new line segments ----
            ctx.globalCompositeOperation = "source-over";
            ctx.globalAlpha = o.particleOpacity;
            ctx.strokeStyle = o.particleColor;
            ctx.lineWidth = o.particleSize * this._ratio;
            ctx.beginPath();

            // Local copies: cheaper than looking up `this._x` thousands of times.
            const px = this._px;
            const py = this._py;
            const age = this._age;
            const maxAge = this._maxAge;
            const gu = this._gu;
            const gv = this._gv;
            const gridW = this._gw;
            const gridH = this._gh;
            const toGrid = 1 / this._cell;

            // Pixels moved per frame for 1 m/s of wind. Deliberately independent of zoom, so the
            // motion looks the same at every zoom level (as on windy.com); particle density is
            // constant too, because the count is spread over the same screen-sized canvas.
            const pixelsPerMps = 0.15 * o.particleSpeed * this._ratio;

            // ---- 3. move every particle ----
            for (let i = 0, n = px.length; i < n; i++) {
                // Dormant or too old: try to place it somewhere new; skip it this frame if impossible.
                const a = age[i];
                if (a < 0 || a >= maxAge[i]) {
                    if (!this._spawn(i)) continue;
                }

                const x = px[i];
                const y = py[i];

                // Which screen-grid cell is the particle in, and where inside it?
                const gx = x * toGrid;
                const gy = y * toGrid;
                const ix = gx | 0;           // left cell index (fast floor for positive numbers)
                const iy = gy | 0;           // top cell index
                if (gx < 0 || gy < 0 || ix >= gridW - 1 || iy >= gridH - 1) {
                    age[i] = -1;             // left the canvas: respawn next frame
                    continue;
                }
                const fx = gx - ix;          // 0..1 across the cell
                const fy = gy - iy;          // 0..1 down the cell
                const b = iy * gridW + ix;   // index of the cell's top-left corner

                // Bilinear interpolation of the wind from the 4 corners (the same idea as in
                // WindData.sample, see wind-data.js).
                const u = (gu[b] * (1 - fx) + gu[b + 1] * fx) * (1 - fy) +
                    (gu[b + gridW] * (1 - fx) + gu[b + gridW + 1] * fx) * fy;
                const v = (gv[b] * (1 - fx) + gv[b + 1] * fx) * (1 - fy) +
                    (gv[b + gridW] * (1 - fx) + gv[b + gridW + 1] * fx) * fy;

                if (u !== u || v !== v) {    // NaN: entered an area without data
                    age[i] = -1;
                    continue;
                }

                // Move, and add one segment (old position -> new position) to the shared path.
                const nx = x + u * pixelsPerMps;
                const ny = y - v * pixelsPerMps;       // minus: screen y grows downwards
                ctx.moveTo(x, y);
                ctx.lineTo(nx, ny);
                px[i] = nx;
                py[i] = ny;
                age[i] = age[i] + 1;       // re-read: _spawn may have reset the age to 0 above
            }

            // ---- 4. draw all segments with a single call ----
            ctx.stroke();
        }
    };
})(globalThis);

/* ===== src/time-dimension.js ===== */
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

/* ===== src/leaflet.easyvelocity.js ===== */
/*
 * src/leaflet.easyvelocity.js — the L.easyVelocity layer (entry point; load this file LAST)
 * ==============================================================================
 *
 * Applications normally load the single built file instead, dist/leaflet.easyvelocity.js, which is
 * these src/ files joined in the order below (see tools/build-dist.js).
 *
 *   const wind = L.easyVelocity({ source: "test" }).addTo(map);
 *   const wind = L.easyVelocity({ source: "https://.../gfs.t00z.pgrb2.0p25.f000" }).addTo(map);
 *
 * leaflet.easyvelocity is a Leaflet plugin that draws wind as a coloured speed field plus animated
 * particles, on its own <canvas> elements (it does not use Leaflet's SVG/Canvas renderers,
 * so the host map's `preferCanvas` setting makes no difference).
 *
 * THE FILES, in load order (see examples/index.html), and how they relate
 * -----------------------------------------------------------------------
 *  DATA SIDE: getting wind numbers. No Leaflet, no drawing. Could run in a Web Worker.
 *    src/grib2-unpack.js   decodes GRIB2 packed numbers (bit reader, packing formulas)
 *    src/grib2-reader.js   walks a GRIB2 message, reads its metadata, calls the unpacker
 *    src/wind-data.js      WindData: the wind grid + "what is the wind at lat/lon?"
 *    src/test-field.js     a synthetic WindData for development ("test" source)
 *    src/grib-loader.js    URL -> WindData (index + Range requests, or streaming)
 *    src/time-sources.js   list of (time, source) pairs -> times + timeSource for a time slider
 *    src/gfs.js            NOAA GFS / GEFS URL and forecast-time helpers
 *
 *  LAYER SIDE: drawing. Mixins that become methods of the layer defined in THIS file.
 *    src/frame-cache.js    loading + caching one WindData per time step, setTime()
 *    src/speed-field.js    colour scale, the on-screen wind grid, painting the speed field
 *    src/particles.js      the animated particles
 *
 *  OPTIONAL:
 *    src/time-dimension.js glue to the Leaflet.TimeDimension slider / player
 *
 *  THIS FILE: the Leaflet layer itself: options, the public API, how the canvases are placed
 *  on the map, and how they follow panning, zooming and resizing.
 *
 * The two halves only meet through WindData: the layer never sees GRIB, and the loaders never
 * see the map. To support a new data format, write a loader that returns a WindData.
 *
 * HOW THE LAYER STAYS ALIGNED WITH THE MAP
 * ----------------------------------------
 * Leaflet keeps all layers inside "panes" (divs). While you drag the map, Leaflet moves the
 * whole pane, so anything inside it moves for free. Our two canvases live in a pane too and are
 * a bit LARGER than the visible map (option `padding`), so a bit of extra map can be dragged
 * into view before we have to redraw. When the movement ENDS (moveend) we re-centre the canvases
 * on the new view and re-sample the wind (speed-field.js). During a zoom animation Leaflet
 * scales the canvases with a CSS transform (_updateTransform), then we redraw at the new zoom.
 */
(function (root) {
    "use strict";

    const L = root.L;
    const parts = root.EasyVelocityParts;

    // ---- friendly error if a script tag is missing or in the wrong order ----
    if (!L || !L.Layer) {
        throw new Error("leaflet.easyvelocity: Leaflet (global L) must be loaded before leaflet.easyvelocity.js.");
    }
    const required = {
        "src/grib2-unpack.js": "unpack", "src/grib2-reader.js": "grib2", "src/wind-data.js": "WindData",
        "src/test-field.js": "createTestField", "src/grib-loader.js": "loadSource", "src/time-sources.js": "timeList",
        "src/gfs.js": "gfsUrl",
        "src/frame-cache.js": "frameLoading", "src/speed-field.js": "speedField", "src/particles.js": "particles",
        "src/time-dimension.js": "installTimeDimension"
    };
    const missing = Object.keys(required).filter((file) => !parts || !parts[required[file]]);
    if (missing.length) {
        throw new Error("leaflet.easyvelocity: these scripts are missing or loaded after leaflet.easyvelocity.js: " + missing.join(", "));
    }

    const EasyVelocity = L.Layer.extend({

        // The mixins add: start/stop (particles), reload/setSource/setTime/... (frame-cache),
        // getLegend and the field painting (speed-field).
        includes: [parts.frameLoading, parts.speedField, parts.particles],

        options: {
            // ---- data ----
            source: "test",            // "test" | a GRIB2 URL | a WindData object
            timeSource: null,          // optional: (timeMs) => source. Gives each time its own file; overrides `source`
            cacheFrames: 6,            // how many decoded time steps to keep in memory
            level: 10,                 // which wind to use: 10 = 10 m above ground (for levelType 100: hPa, e.g. 850)
            levelType: 103,            // GRIB2 level type: 103 = metres above ground, 100 = pressure level
            fetchOptions: {},          // extra fetch() options for the streaming download

            // ---- particles ----
            particleCount: 4000,
            particleSpeed: 1.0,        // speed multiplier
            particleSize: 1,           // line width in CSS pixels
            particleOpacity: 0.8,
            particleColor: "#ffffff",
            particleMaxAge: 100,       // lifetime in animation frames
            trailLength: 0.9,          // 0..1: fraction of a trail kept each frame (higher = longer trails)
            showParticles: true,

            // ---- speed field ----
            showSpeedField: true,
            opacity: 0.75,             // opacity of the colour field
            colorScale: null,          // [[speed m/s, cssColor], ...]; null = default (see speed-field.js)

            // ---- behaviour ----
            pane: "overlayPane",       // Leaflet pane the canvases are placed in
            autoStart: true,           // start animating as soon as the layer is on the map
            padding: 0.25,             // canvas extends this fraction beyond the viewport on every side
            fieldResolution: 4,        // CSS pixels between wind samples of the screen grid
            pixelRatio: 1              // canvas pixels per CSS pixel (2 = sharper on retina, 4x the work)
        },

        // Runs once when you call L.easyVelocity(...). Sets up the state the mixins use.
        initialize: function (options) {
            L.setOptions(this, options);
            if (!this.options.colorScale) this.options.colorScale = parts.defaultColorScale;

            // -- data / frame cache (frame-cache.js) --
            this._data = null;          // the WindData currently displayed
            this._status = "idle";      // "idle" | "loading" | "ready" | "error"
            this._error = null;
            this._frames = new Map();   // cache: key -> { promise, data, abort }
            this._time = null;          // current time in ms (set by setTime)
            this._t0 = null;            // first time shown; origin of the synthetic field's motion
            this._loadToken = 0;        // numbers load requests so stale ones can be ignored

            // -- screen grid (speed-field.js) --
            this._gridReady = false;
            this._rebuildHandle = 0;
            this._tmp = new Float32Array(2);   // scratch space for WindData.sample()

            // -- particles / animation (particles.js) --
            this._wantRunning = this.options.autoStart !== false;
            this._raf = 0;
            this._needRespawn = true;
            this._tick = this._tick.bind(this);   // so it can be handed to requestAnimationFrame

            this._buildLut();
            this._allocParticles();
        },

        // ---- public API (the rest comes from the mixins) ------------------

        /**
         * Change any option while the layer is running, e.g. wind.setOptions({ particleCount: 8000 }).
         * Only the parts that depend on the changed options are redone.
         */
        setOptions: function (opts) {
            const previous = L.extend({}, this.options);
            const sourceChanged = opts && (
                ("source" in opts && opts.source !== previous.source) ||
                ("timeSource" in opts && opts.timeSource !== previous.timeSource) ||
                ("level" in opts && opts.level !== previous.level) ||
                ("levelType" in opts && opts.levelType !== previous.levelType));

            L.setOptions(this, opts);
            const o = this.options;

            if (o.particleCount !== previous.particleCount) {
                this._allocParticles();
                if (this._gridReady) this._initParticles();
            }
            if (o.colorScale !== previous.colorScale) {
                this._buildLut();
                if (this._gridReady) this._drawField();
            }
            if (this._wrap) {
                this._applyVisibility();
                if (!o.showParticles && this._pctx) this._pctx.clearRect(0, 0, this._cw, this._ch);
                if (o.fieldResolution !== previous.fieldResolution ||
                    o.pixelRatio !== previous.pixelRatio ||
                    o.padding !== previous.padding) {
                    this._update();
                }
            }
            if (sourceChanged) {
                this._clearFrames();
                this._load();
            }
            return this;
        },

        getSource: function () { return this.options.source; },
        getStatus: function () { return this._status; },       // "idle" | "loading" | "ready" | "error"
        getError: function () { return this._error; },
        getData: function () { return this._data; },            // the WindData on screen

        /** Wind at a point from the cached data: { u, v, speed } or null if there is no data there. */
        getVector: function (lat, lon) {
            return this._data ? this._data.getVector(lat, lon) : null;
        },

        // ---- Leaflet layer lifecycle -------------------------------------

        /** Leaflet calls this to learn which map events the layer wants (and unsubscribes automatically on removal). */
        getEvents: function () {
            // Dragging needs no handler: the canvases sit in a map pane and move with it.
            const events = {
                viewreset: this._update,      // map was reset (e.g. after a zoom): reposition and redraw
                zoom: this._onZoom,           // during a zoom: scale the canvases to match
                moveend: this._update,        // movement finished: recentre the canvases
                resize: this._update          // map container changed size
            };
            if (this._zoomAnimated) events.zoomanim = this._onAnimZoom;   // animated zoom is starting
            return events;
        },

        /** Leaflet calls this when the layer is added to a map. Builds the canvases. */
        onAdd: function (map) {
            // A wrapper div positioned inside the map pane, holding the two canvases:
            //   _fieldCanvas     the colour field (underneath)
            //   _particleCanvas  the particles and trails (on top)
            const wrap = this._wrap = L.DomUtil.create(
                "div", "leaflet-easyvelocity-layer" + (this._zoomAnimated ? " leaflet-zoom-animated" : ""));
            wrap.style.position = "absolute";
            wrap.style.left = "0";
            wrap.style.top = "0";
            wrap.style.pointerEvents = "none";     // clicks and drags pass through to the map

            this._fieldCanvas = document.createElement("canvas");
            this._particleCanvas = document.createElement("canvas");
            for (const canvas of [this._fieldCanvas, this._particleCanvas]) {
                canvas.style.position = "absolute";
                canvas.style.left = "0";
                canvas.style.top = "0";
                wrap.appendChild(canvas);
            }
            this._fctx = this._fieldCanvas.getContext("2d");
            this._pctx = this._particleCanvas.getContext("2d");

            this._origin = null;
            this._zoom = null;
            this._cw = this._ch = 0;

            map.getPane(this.options.pane).appendChild(wrap);
            this._applyVisibility();
            this._update();

            if (!this._data && this._status !== "loading") this._load();   // first time on a map: get data
            this._schedule();                                                // start the animation loop
        },

        /** Leaflet calls this when the layer is removed from the map. The decoded data stays cached. */
        onRemove: function () {
            this._cancelFrame();
            if (this._rebuildHandle) {
                cancelAnimationFrame(this._rebuildHandle);
                this._rebuildHandle = 0;
            }
            L.DomUtil.remove(this._wrap);
            this._wrap = this._fieldCanvas = this._particleCanvas = this._fctx = this._pctx = null;
            this._gridReady = false;
        },

        // ---- keeping the canvases aligned with the map -------------------

        /**
         * (Re)size and (re)position the canvases so they cover the visible map plus `padding`,
         * then ask for the screen grid to be rebuilt. Runs on add, moveend, viewreset, resize.
         */
        _update: function () {
            if (!this._map || !this._wrap) return;
            const map = this._map;
            const padding = this.options.padding;
            const ratio = this._ratio = Math.max(0.5, this.options.pixelRatio || 1);

            // Canvas size = visible map size * (1 + 2 * padding); `min` = its top-left corner in
            // "layer points" (Leaflet's pixel coordinates inside the map panes).
            const mapSize = map.getSize();
            const min = map.containerPointToLayerPoint(mapSize.multiplyBy(-padding)).round();
            const cssSize = mapSize.multiplyBy(1 + padding * 2).round();
            const w = Math.max(1, Math.round(cssSize.x * ratio));
            const h = Math.max(1, Math.round(cssSize.y * ratio));
            const zoom = map.getZoom();

            if (this._origin && this._zoom === zoom && w === this._cw && h === this._ch) {
                // Only panned: keep each particle at the same GEOGRAPHIC spot. The canvas moved by
                // (previousOrigin - newOrigin) on screen, so shift the particles' canvas
                // coordinates by the same amount.
                const previous = map.latLngToLayerPoint(this._originLatLng);
                const dx = (previous.x - min.x) * ratio;
                const dy = (previous.y - min.y) * ratio;
                if (dx || dy) {
                    const px = this._px;
                    const py = this._py;
                    for (let i = 0; i < px.length; i++) {
                        px[i] += dx;
                        py[i] += dy;
                    }
                }
            } else {
                // Zoomed or resized: positions no longer mean anything, scatter new particles.
                this._needRespawn = true;
            }

            this._origin = min;
            this._originLatLng = map.layerPointToLatLng(min);   // remember it geographically for the next pan
            this._center = map.getCenter();
            this._zoom = zoom;

            for (const canvas of [this._fieldCanvas, this._particleCanvas]) {
                if (canvas.width !== w) canvas.width = w;       // (changing width also clears the canvas)
                if (canvas.height !== h) canvas.height = h;
                canvas.style.width = cssSize.x + "px";
                canvas.style.height = cssSize.y + "px";
            }
            this._cw = w;
            this._ch = h;
            this._pctx.clearRect(0, 0, w, h);                   // old trails no longer line up
            L.DomUtil.setPosition(this._wrap, min);             // this also removes any zoom transform
            this._invalidateField();
        },

        _onZoom: function () {
            this._updateTransform(this._map.getCenter(), this._map.getZoom());
        },

        _onAnimZoom: function (e) {
            this._updateTransform(e.center, e.zoom);
        },

        /**
         * During a zoom, stretch the existing canvases to look right until the zoom ends and we
         * redraw. Same maths as Leaflet's own canvas renderer: compute where the canvas will be
         * and how much it is scaled at the target zoom, and apply it as a CSS transform.
         */
        _updateTransform: function (center, zoom) {
            if (!this._wrap || !this._center) return;
            const map = this._map;
            const scale = map.getZoomScale(zoom, this._zoom);
            const viewHalf = map.getSize().multiplyBy(0.5 + this.options.padding);
            const currentCenterPoint = map.project(this._center, zoom);
            const offset = viewHalf.multiplyBy(-scale)
                .add(currentCenterPoint)
                .subtract(map._getNewPixelOrigin(center, zoom));    // (a private Leaflet method, as used by Leaflet itself)
            if (L.Browser.any3d) L.DomUtil.setTransform(this._wrap, offset, scale);
            else L.DomUtil.setPosition(this._wrap, offset);
        },

        /** Apply showSpeedField / showParticles / opacity to the canvases. */
        _applyVisibility: function () {
            this._fieldCanvas.style.display = this.options.showSpeedField ? "" : "none";
            this._fieldCanvas.style.opacity = String(this.options.opacity);
            this._particleCanvas.style.display = this.options.showParticles ? "" : "none";
        }
    });

    // ---- public exports ----------------------------------------------------

    L.EasyVelocity = EasyVelocity;
    L.easyVelocity = function (options) { return new EasyVelocity(options); };
    L.WindField = EasyVelocity;
    L.windField = L.easyVelocity;

    // Handy extras for application code and the demo page.
    L.easyVelocity.WindData = parts.WindData;
    L.easyVelocity.Grib2 = parts.grib2;
    L.easyVelocity.createTestField = parts.createTestField;
    L.easyVelocity.gfsUrl = parts.gfsUrl;
    L.easyVelocity.gfsForecast = parts.gfsForecast;
    L.easyVelocity.gfsAnalyses = parts.gfsAnalyses;
    L.easyVelocity.gefsMeanUrl = parts.gefsMeanUrl;
    L.easyVelocity.gefsMeanForecast = parts.gefsMeanForecast;
    L.easyVelocity.timeList = parts.timeList;
    L.easyVelocity.defaultColorScale = parts.defaultColorScale;
    L.easyVelocity.installTimeDimension = parts.installTimeDimension;

    L.windField.WindData = L.easyVelocity.WindData;
    L.windField.Grib2 = L.easyVelocity.Grib2;
    L.windField.createTestField = L.easyVelocity.createTestField;
    L.windField.gfsUrl = L.easyVelocity.gfsUrl;
    L.windField.gfsForecast = L.easyVelocity.gfsForecast;
    L.windField.gfsAnalyses = L.easyVelocity.gfsAnalyses;
    L.windField.gefsMeanUrl = L.easyVelocity.gefsMeanUrl;
    L.windField.gefsMeanForecast = L.easyVelocity.gefsMeanForecast;
    L.windField.timeList = L.easyVelocity.timeList;
    L.windField.defaultColorScale = L.easyVelocity.defaultColorScale;
    L.windField.installTimeDimension = L.easyVelocity.installTimeDimension;

    // If Leaflet.TimeDimension was loaded first, enable L.timeDimension.layer.easyVelocity(...).
    parts.installTimeDimension();
})(globalThis);
