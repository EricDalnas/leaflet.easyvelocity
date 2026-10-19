/*
 * netcdf4-reader.js — reading NetCDF-4 files through the h5wasm library
 * ======================================================================
 *
 * Part of leaflet.easyvelocity. Pure JavaScript; needs the h5wasm script ONLY for NetCDF-4 files.
 *
 * NetCDF-4 is stored as HDF5, a much more complex format than NetCDF classic (compression,
 * chunking, B-trees, heaps). Instead of re-implementing it, this file uses h5wasm: the official
 * HDF5 C library compiled to WebAssembly (https://github.com/usnistgov/h5wasm, NIST + HDF5
 * BSD-style licences, no copyleft). It is NOT part of this plugin; a page that needs NetCDF-4
 * loads it itself, before or after leaflet.easyvelocity.js:
 *
 *   <script src="https://cdn.jsdelivr.net/npm/h5wasm@0.10.3/dist/iife/h5wasm.js"></script>
 *
 * HOW NETCDF-4 MAPS ONTO HDF5
 * ---------------------------
 *   variable      an HDF5 dataset, its attributes are HDF5 attributes
 *   dimension     a "dimension scale" dataset (attribute CLASS = "DIMENSION_SCALE"); for a
 *                 coordinate variable such as `lat` it is the variable itself
 *   which dims    each variable has the scales "attached" to its axes
 *
 * open() turns that into the same { dimensions, variables, attributes } shape that
 * netcdf-reader.js returns for classic files, so netcdf-loader.js does not need to care.
 */
(function (root) {
    "use strict";

    const parts = (root.EasyVelocityParts = root.EasyVelocityParts || {});

    // Bookkeeping attributes netCDF-C / HDF5 add; not part of the netCDF data model.
    const HIDDEN = new Set(["CLASS", "NAME", "REFERENCE_LIST", "DIMENSION_LIST", "_Netcdf4Dimid",
        "_Netcdf4Coordinates", "_NCProperties", "_nc3_strict", "_IsNetcdf4"]);
    const NO_VARIABLE = "This is a netCDF dimension but not a netCDF variable";

    let fileNumber = 0;

    // h5wasm throws for a missing attribute, so look before reading.
    const attribute = (object, name) => name in object.attrs ? object.get_attribute(name, true) : undefined;

    function library() {
        const lib = root.h5wasm;
        const h5 = lib && (lib.File ? lib : lib.default);
        if (!h5) {
            throw new Error("This is a NetCDF-4 (HDF5) file. Reading it needs the h5wasm script on the page: " +
                "<script src=\"https://cdn.jsdelivr.net/npm/h5wasm@0.10.3/dist/iife/h5wasm.js\"></script>");
        }
        return h5;
    }

    function readAttributes(object) {
        const result = {};
        for (const name of Object.keys(object.attrs)) {
            if (HIDDEN.has(name)) continue;
            const value = object.get_attribute(name, true);
            result[name] = typeof value === "string" ? value
                : Array.isArray(value) ? value.flat(Infinity) : [value];
        }
        return result;
    }

    // HDF5 type -> netCDF type name (only used to know the default fill value).
    function typeName(meta) {
        if (meta.type === 1) return meta.size === 8 ? "double" : "float";
        const names = { 1: ["ubyte", "byte"], 2: ["ushort", "short"], 4: ["uint", "int"], 8: ["uint64", "int64"] }[meta.size];
        return names ? names[meta.signed ? 1 : 0] : "other";
    }

    /**
     * @param {Uint8Array} bytes  the whole file
     * @returns {Promise<object>} { version: 4, dimensions, attributes, variables, readVariable(), close() }
     */
    async function open(bytes) {
        const h5 = library();
        const { FS } = await h5.ready;
        const path = "/easyvelocity-" + (++fileNumber) + ".nc";
        FS.writeFile(path, bytes);
        const h5file = new h5.File(path, "r");

        const dimensions = [];
        const variables = [];
        const dimByPath = new Map();
        const datasets = h5file.keys().map((name) => ({ name, d: h5file.get(name) }))
            .filter((x) => x.d instanceof h5.Dataset);

        // Dimension scales first, so the variables can refer to them.
        for (const { name, d } of datasets) {
            if (attribute(d, "CLASS") !== "DIMENSION_SCALE") continue;
            dimByPath.set("/" + name, dimensions.length);
            dimensions.push({ name, size: d.shape[0], isRecord: false });
        }
        for (const { name, d } of datasets) {
            const isDimension = dimByPath.has("/" + name);
            if (isDimension && String(attribute(d, "NAME")).startsWith(NO_VARIABLE)) continue;
            const shape = d.shape || [];
            const dims = shape.map((size, i) => {
                if (isDimension && shape.length === 1) return dimByPath.get("/" + name);
                const scale = d.get_attached_scales(i)[0];
                if (scale !== undefined && dimByPath.has(scale)) return dimByPath.get(scale);
                dimensions.push({ name: name + "_dim" + i, size, isRecord: false });   // axis without a scale
                return dimensions.length - 1;
            });
            variables.push({ name, dims, shape, attributes: readAttributes(d), type: typeName(d.metadata), dataset: d });
        }

        return {
            version: 4,
            dimensions,
            variables,
            attributes: readAttributes(h5file),

            /** Same contract as netcdf-reader.js readVariable(). */
            readVariable(variable, index, ArrayType) {
                index = index || [];
                const ranges = variable.shape.map((size, d) => d < index.length ? [index[d], index[d] + 1] : []);
                const raw = variable.dataset.slice(ranges);
                const unpack = parts.netcdf.unpacker(variable);
                const out = new (ArrayType || Float64Array)(raw.length);
                for (let i = 0; i < raw.length; i++) out[i] = unpack(Number(raw[i]));
                return out;
            },

            close() {
                h5file.close();
                FS.unlink(path);
            }
        };
    }

    parts.netcdf4 = { open };
})(globalThis);
