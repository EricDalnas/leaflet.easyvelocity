/*
 * netcdf-reader.js — reading a NetCDF "classic" file: its header, attributes and variables
 * =========================================================================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript: no Leaflet, no DOM, no network.
 *
 * WHAT IS NETCDF?
 * ---------------
 * NetCDF is the other common file format for gridded weather and ocean data (GRIB2 is the
 * first). Where GRIB2 is a chain of independent, compressed 2-D messages, a NetCDF file is ONE
 * self-describing container of N-dimensional arrays:
 *
 *   dimensions   named lengths, e.g.   time = 3, latitude = 361, longitude = 720
 *   variables    named arrays over some dimensions, e.g.
 *                    float ugrd10m(time, latitude, longitude)      the U wind
 *                    double latitude(latitude)                     the latitude of each row
 *                A variable with the same name as its only dimension is a "coordinate variable":
 *                it says where along that axis each index lies.
 *   attributes   name = value notes on a variable or on the whole file, e.g.
 *                    ugrd10m:units = "m s-1"      time:units = "seconds since 1970-01-01"
 *                Which attributes mean what is agreed in the CF ("Climate and Forecast") conventions.
 *
 * THE CLASSIC BINARY LAYOUT (what this file reads)
 * ------------------------------------------------
 * Servers such as ERDDAP and THREDDS (and tools like wgrib2 -netcdf) write the "classic" format:
 *
 *   "CDF" + version byte          1 = classic, 2 = 64-bit offsets, 5 = 64-bit data (CDF-5)
 *   number of records
 *   dimension list                name + length; length 0 marks THE "record" (unlimited) dimension
 *   global attribute list
 *   variable list                 name, dimension ids, attributes, data type, and `begin`:
 *                                 the byte offset where the variable's numbers start
 *   ... the numbers, uncompressed, big-endian, in row-major order (last dimension fastest)
 *
 * Every number in the header is a big-endian 32-bit integer (64-bit for sizes in CDF-5, and for
 * offsets in CDF-2 and CDF-5). Names and attribute values are padded to a multiple of 4 bytes.
 *
 * RECORD VARIABLES. A variable whose FIRST dimension is the record dimension is stored
 * interleaved: record 0 of every such variable, then record 1 of every such variable, ...
 * So time step r of variable V is at  V.begin + r * recordSize,  where recordSize is the bytes
 * of one record of ALL record variables together.
 *
 * PACKING. To save space a variable may be stored as small integers plus two attributes:
 *     real value = stored * scale_factor + add_offset
 * and a stored value equal to _FillValue (or missing_value) means "no data" (NaN here).
 *
 * NETCDF-4 is a different format despite the name (built on HDF5, usually compressed). It is
 * handled by netcdf4-reader.js, which returns the same shape of object as parse() below.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    // Data types: number -> [name, bytes per value]
    const TYPES = {
        1: ["byte", 1], 2: ["char", 1], 3: ["short", 2], 4: ["int", 4], 5: ["float", 4], 6: ["double", 8],
        7: ["ubyte", 1], 8: ["ushort", 2], 9: ["uint", 4], 10: ["int64", 8], 11: ["uint64", 8]  // 7..11: CDF-5 only
    };

    // Values a writer puts where no data was ever written, when a variable has no _FillValue.
    const DEFAULT_FILL = {
        byte: -127, short: -32767, int: -2147483647, float: Math.fround(9.9692099683868690e+36),
        double: 9.9692099683868690e+36, ubyte: 255, ushort: 65535, uint: 4294967295
    };

    const TAG_DIMENSION = 0x0A;
    const TAG_VARIABLE = 0x0B;
    const TAG_ATTRIBUTE = 0x0C;

    /** "CDF" followed by version 1, 2 or 5. */
    function isNetcdf(bytes) {
        return bytes.length >= 4 && bytes[0] === 0x43 && bytes[1] === 0x44 && bytes[2] === 0x46 &&
            (bytes[3] === 1 || bytes[3] === 2 || bytes[3] === 5);
    }

    /** "\x89HDF\r\n\x1a\n": the signature of HDF5, i.e. NetCDF-4. */
    function isHdf5(bytes) {
        const sig = [0x89, 0x48, 0x44, 0x46, 0x0D, 0x0A, 0x1A, 0x0A];
        return bytes.length >= 8 && sig.every((b, i) => bytes[i] === b);
    }

    /** Read one value of type `type` at byte `p`. */
    function readValue(view, p, type) {
        switch (type) {
            case "byte": return view.getInt8(p);
            case "char": case "ubyte": return view.getUint8(p);
            case "short": return view.getInt16(p);
            case "ushort": return view.getUint16(p);
            case "int": return view.getInt32(p);
            case "uint": return view.getUint32(p);
            case "float": return view.getFloat32(p);
            case "double": return view.getFloat64(p);
            case "int64": return Number(view.getBigInt64(p));
            case "uint64": return Number(view.getBigUint64(p));
        }
        throw new Error("NetCDF: unknown data type " + type);
    }

    /**
     * Parse the header. The data itself is only read on demand (readVariable).
     *
     * @param {Uint8Array} bytes  the whole file
     * @returns {{version, dimensions, attributes, variables, recordSize, numRecords, bytes, view}}
     *   dimensions  [{ name, size, isRecord }]
     *   attributes  { name: string | number[] }
     *   variables   [{ name, dims: [dimension index], shape: [sizes], attributes, type, begin, isRecord }]
     */
    function parse(bytes) {
        if (isHdf5(bytes)) throw new Error("This is a NetCDF-4 (HDF5) file: open it with netcdf4-reader.js.");
        if (!isNetcdf(bytes)) throw new Error("Not a NetCDF file (it does not start with \"CDF\").");

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const version = bytes[3];
        let p = 4;

        const u32 = () => { const v = view.getUint32(p); p += 4; return v; };
        const u64 = () => { const v = view.getUint32(p) * 4294967296 + view.getUint32(p + 4); p += 8; return v; };
        const count = version === 5 ? u64 : u32;          // sizes and list lengths
        const offset = version === 1 ? u32 : u64;         // byte offsets (`begin`)
        const pad4 = (n) => (n + 3) & ~3;

        const name = () => {
            const length = count();
            const text = new TextDecoder().decode(bytes.subarray(p, p + length));
            p += pad4(length);
            return text;
        };

        // A list starts with a tag and a length; "absent" is written as two zeros.
        const list = (tag, readItem) => {
            const t = u32();
            const n = count();
            if (t === 0 && n === 0) return [];
            if (t !== tag) throw new Error("NetCDF: corrupt header near byte " + (p - 8));
            const items = [];
            for (let i = 0; i < n; i++) items.push(readItem());
            return items;
        };

        const attributes = () => {
            const result = {};
            for (const [key, value] of list(TAG_ATTRIBUTE, () => {
                const key = name();
                const type = TYPES[u32()];
                const n = count();
                if (!type) throw new Error("NetCDF: unknown attribute type in " + key);
                let value;
                if (type[0] === "char") {
                    value = new TextDecoder().decode(bytes.subarray(p, p + n)).replace(/\0+$/, "");
                } else {
                    value = [];
                    for (let i = 0; i < n; i++) value.push(readValue(view, p + i * type[1], type[0]));
                }
                p += pad4(n * type[1]);
                return [key, value];
            })) result[key] = value;
            return result;
        };

        let numRecords = u32();
        if (version === 5) numRecords = numRecords * 4294967296 + u32();
        const streaming = numRecords === 0xFFFFFFFF;      // "unknown, count them": rare

        const dimensions = list(TAG_DIMENSION, () => {
            const dimName = name();
            const size = count();
            return { name: dimName, size, isRecord: size === 0 };
        });
        const globalAttributes = attributes();
        const variables = list(TAG_VARIABLE, () => {
            const varName = name();
            const nDims = count();
            const dims = [];
            for (let i = 0; i < nDims; i++) dims.push(count());
            const varAttributes = attributes();
            const type = TYPES[u32()];
            if (!type) throw new Error("NetCDF: unknown data type in variable " + varName);
            count();                                      // vsize: recomputed below, it can overflow
            const begin = offset();
            return {
                name: varName, dims, attributes: varAttributes, type: type[0], typeSize: type[1], begin,
                isRecord: dims.length > 0 && dimensions[dims[0]].isRecord
            };
        });

        // Bytes of ONE record of a record variable: the product of its other dimensions.
        const recordVars = variables.filter((v) => v.isRecord);
        for (const v of variables) {
            v.sliceBytes = v.dims.slice(v.isRecord ? 1 : 0).reduce((n, d) => n * dimensions[d].size, v.typeSize);
        }
        // Each variable's share of a record is padded to 4 bytes, except when there is only one.
        const recordSize = recordVars.length === 1 ? recordVars[0].sliceBytes
            : recordVars.reduce((n, v) => n + pad4(v.sliceBytes), 0);

        if (streaming) {
            numRecords = recordSize && recordVars.length
                ? Math.floor((bytes.length - Math.min(...recordVars.map((v) => v.begin))) / recordSize) : 0;
        }
        for (const d of dimensions) if (d.isRecord) d.size = numRecords;
        for (const v of variables) v.shape = v.dims.map((d) => dimensions[d].size);

        return { version, dimensions, attributes: globalAttributes, variables, recordSize, numRecords, bytes, view };
    }

    /** The variable called `name`, or undefined. */
    function getVariable(file, name) {
        return file.variables.find((v) => v.name === name);
    }

    /**
     * A function stored value -> real value for `variable`: applies scale_factor / add_offset and
     * turns _FillValue / missing_value (or the type's default fill) into NaN.
     */
    function unpacker(variable) {
        const a = variable.attributes;
        const scale = a.scale_factor ? a.scale_factor[0] : 1;
        const add = a.add_offset ? a.add_offset[0] : 0;
        const missing = [];
        if (Array.isArray(a._FillValue)) missing.push(a._FillValue[0]);
        else if (variable.type in DEFAULT_FILL) missing.push(DEFAULT_FILL[variable.type]);
        if (Array.isArray(a.missing_value)) missing.push(...a.missing_value);
        const m0 = missing.length > 0 ? missing[0] : NaN;   // usually the only one: checked without a loop
        const m1 = missing.length > 1 ? missing[1] : NaN;
        const more = missing.slice(2);
        return (raw) => raw !== raw || raw === m0 || raw === m1 || (more.length && more.includes(raw))
            ? NaN : raw * scale + add;
    }

    /**
     * Read (part of) a variable as plain numbers, with packing and missing values applied.
     *
     * @param {object} file      from parse() (or netcdf4-reader.js open())
     * @param {object} variable  one of file.variables
     * @param {number[]} [index] fixed indices for the FIRST dimensions; the rest is read whole.
     *        E.g. for u(time, latitude, longitude), [2] reads the 2-D grid of time step 2.
     * @param {Function} [ArrayType]  Float64Array (default) or Float32Array
     * @returns {Float64Array|Float32Array}  missing values are NaN
     */
    function readVariable(file, variable, index, ArrayType) {
        if (file.readVariable) return file.readVariable(variable, index, ArrayType);
        index = index || [];
        ArrayType = ArrayType || Float64Array;
        const shape = variable.shape;
        if (index.length > shape.length) throw new Error("NetCDF: too many indices for " + variable.name);
        index.forEach((k, d) => {
            if (!(k >= 0 && k < shape[d])) throw new Error("NetCDF: index " + k + " out of range for " + variable.name);
        });

        // Elements per step of each dimension ("strides"), counted within one record for record variables.
        const first = variable.isRecord ? 1 : 0;
        const stride = new Array(shape.length).fill(1);
        for (let d = shape.length - 2; d >= first; d--) stride[d] = stride[d + 1] * shape[d + 1];

        // How many values one contiguous run has, and where each run starts.
        const fixed = Math.max(index.length, first);
        const runLength = shape.slice(fixed).reduce((n, s) => n * s, 1);
        let start = 0;
        for (let d = first; d < index.length; d++) start += index[d] * stride[d];
        const records = !variable.isRecord ? [0] : index.length ? [index[0]]
            : Array.from({ length: file.numRecords }, (_, r) => r);

        const unpack = unpacker(variable);
        const out = new ArrayType(records.length * runLength);
        const view = file.view;
        const type = variable.type;
        const size = variable.typeSize;
        let k = 0;
        for (const r of records) {
            let p = variable.begin + r * (variable.isRecord ? file.recordSize : 0) + start * size;
            if (p + runLength * size > view.byteLength) throw new Error("NetCDF: file is truncated (" + variable.name + ")");
            for (let i = 0; i < runLength; i++, p += size) out[k++] = unpack(readValue(view, p, type));
        }
        return out;
    }

    parts.netcdf = { isNetcdf, isHdf5, parse, getVariable, readVariable, unpacker };
})(globalThis);
