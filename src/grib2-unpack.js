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
