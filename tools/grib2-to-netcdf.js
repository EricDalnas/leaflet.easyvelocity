/*
 * tools/grib2-to-netcdf.js — turns GRIB2 files with 10 m U/V wind into ONE NetCDF (classic) file
 *
 * OPTIONAL, for maintainers only: plain Node, no dependencies. It made the demo's NetCDF sample
 * from the bundled GRIB2 files, using the plugin's own GRIB2 decoder:
 *
 *   node tools/grib2-to-netcdf.js examples/data/gfs-20220928-0p50-10m-uv.nc --stride 2 --pack
 *        examples/data/gfs-20220928-06z-f000-10m-uv.grib2 examples/data/gfs-20220928-12z-f000-10m-uv.grib2
 *        examples/data/gfs-20220928-18z-f000-10m-uv.grib2
 *
 * Each input file becomes one time step. The layout is the one wgrib2 -netcdf writes: `time` is
 * the unlimited (record) dimension, latitude runs south to north, and the variables are called
 * UGRD_10maboveground / VGRD_10maboveground.
 *   --stride N   keep every Nth grid point in both directions (2: 0.25° -> 0.5°, a quarter of the size)
 *   --pack       store 16-bit integers with scale_factor 0.01 m/s instead of 32-bit floats (half the size)
 */
const fs = require("fs");
const path = require("path");

for (const name of ["grib2-unpack.js", "grib2-reader.js"]) require(path.join(__dirname, "..", "src", name));
const grib2 = globalThis.EasyVelocityParts.grib2;

// ---- command line ----
const args = process.argv.slice(2);
let stride = 1;
let pack = false;
const files = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stride") stride = Math.max(1, parseInt(args[++i], 10) || 1);
    else if (args[i] === "--pack") pack = true;
    else files.push(args[i]);
}
const output = files.shift();
if (!output || !files.length) {
    console.error("usage: node tools/grib2-to-netcdf.js out.nc [--stride N] [--pack] in1.grib2 [in2.grib2 ...]");
    process.exit(1);
}

// ---- read the 10 m U and V of every input file ----
const steps = files.map((file) => {
    const bytes = new Uint8Array(fs.readFileSync(file));
    const found = [];
    for (let p = 0; p < bytes.length;) {
        const length = grib2.messageLength(bytes.subarray(p));
        found.push(...grib2.parseMessage(bytes.subarray(p, p + length),
            (f) => f.discipline === 0 && f.category === 2 && (f.number === 2 || f.number === 3) &&
                f.levelType === 103 && f.levelValue === 10));
        p += length;
    }
    const u = found.find((f) => f.number === 2);
    const v = found.find((f) => f.number === 3);
    if (!u || !v) throw new Error(file + ": no 10 m UGRD/VGRD pair");
    return { file, u, v };
}).sort((a, b) => a.u.validTime - b.u.validTime);

const g = steps[0].u.grid;
for (const s of steps) {
    for (const f of [s.u, s.v]) {
        if (["ni", "nj", "lat0", "lon0", "dx", "dy"].some((k) => f.grid[k] !== g[k])) throw new Error(s.file + ": different grid");
    }
}

// Output grid: every `stride`-th point, rows reordered south -> north.
const ni = Math.ceil(g.ni / stride);
const nj = Math.ceil(g.nj / stride);
const southFirst = g.dy < 0;
const rowOf = (j) => (southFirst ? nj - 1 - j : j) * stride;           // output row -> input row
const latitudes = Array.from({ length: nj }, (_, j) => g.lat0 + rowOf(j) * g.dy);
const longitudes = Array.from({ length: ni }, (_, i) => g.lon0 + i * stride * g.dx);

// ---- a tiny big-endian writer for the NetCDF classic (CDF-1) format ----
const NC_CHAR = 2, NC_SHORT = 3, NC_FLOAT = 5, NC_DOUBLE = 6;
const SIZE = { [NC_CHAR]: 1, [NC_SHORT]: 2, [NC_FLOAT]: 4, [NC_DOUBLE]: 8 };
const pad4 = (n) => (n + 3) & ~3;

class Writer {
    constructor() { this.chunks = []; this.length = 0; }
    bytes(b) { this.chunks.push(Buffer.from(b)); this.length += b.length; }
    int(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.bytes(b); }
    pad() { if (this.length % 4) this.bytes(Buffer.alloc(4 - this.length % 4)); }
    name(s) { const b = Buffer.from(s, "utf8"); this.int(b.length); this.bytes(b); this.pad(); }
    values(type, list) {
        const b = Buffer.alloc(list.length * SIZE[type]);
        list.forEach((x, i) => {
            if (type === NC_SHORT) b.writeInt16BE(x, i * 2);
            else if (type === NC_FLOAT) b.writeFloatBE(x, i * 4);
            else if (type === NC_DOUBLE) b.writeDoubleBE(x, i * 8);
        });
        this.bytes(b);
        this.pad();
    }
    attributes(attrs) {
        const entries = Object.entries(attrs);
        if (!entries.length) { this.int(0); this.int(0); return; }
        this.int(0x0C); this.int(entries.length);
        for (const [key, [type, value]] of entries) {
            this.name(key);
            this.int(type);
            if (type === NC_CHAR) { const b = Buffer.from(value, "utf8"); this.int(b.length); this.bytes(b); this.pad(); }
            else { this.int(value.length); this.values(type, value); }
        }
    }
    toBuffer() { return Buffer.concat(this.chunks); }
}

const dataType = pack ? NC_SHORT : NC_FLOAT;
const FILL = pack ? -32767 : 9.999e20;   // 9.999e20 is wgrib2's fill value
const SCALE = 0.01;
const windAttributes = (shortName, longName) => Object.assign({
    short_name: [NC_CHAR, shortName],
    long_name: [NC_CHAR, longName],
    level: [NC_CHAR, "10 m above ground"],
    units: [NC_CHAR, "m/s"],
    _FillValue: [dataType, [FILL]]
}, pack ? { scale_factor: [NC_FLOAT, [SCALE]], add_offset: [NC_FLOAT, [0]] } : {});

// dims: 0 = time (record), 1 = latitude, 2 = longitude
const variables = [
    { name: "latitude", dims: [1], type: NC_DOUBLE, attrs: { units: [NC_CHAR, "degrees_north"], long_name: [NC_CHAR, "latitude"] } },
    { name: "longitude", dims: [2], type: NC_DOUBLE, attrs: { units: [NC_CHAR, "degrees_east"], long_name: [NC_CHAR, "longitude"] } },
    { name: "time", dims: [0], type: NC_DOUBLE, attrs: {
        units: [NC_CHAR, "seconds since 1970-01-01 00:00:00.0 0:00"], long_name: [NC_CHAR, "verification time"] } },
    { name: "UGRD_10maboveground", dims: [0, 1, 2], type: dataType, attrs: windAttributes("UGRD_10maboveground", "U-Component of Wind") },
    { name: "VGRD_10maboveground", dims: [0, 1, 2], type: dataType, attrs: windAttributes("VGRD_10maboveground", "V-Component of Wind") }
];
const dimSizes = [0, nj, ni];
for (const v of variables) {
    v.isRecord = v.dims[0] === 0;
    v.vsize = pad4(v.dims.filter((d) => d !== 0).reduce((n, d) => n * dimSizes[d], SIZE[v.type]));
}

function header(begins) {
    const w = new Writer();
    w.bytes([0x43, 0x44, 0x46, 1]);                       // "CDF", version 1
    w.int(steps.length);                                  // number of records
    w.int(0x0A); w.int(3);
    w.name("time"); w.int(0);
    w.name("latitude"); w.int(nj);
    w.name("longitude"); w.int(ni);
    w.attributes({
        Conventions: [NC_CHAR, "COARDS"],
        title: [NC_CHAR, "NOAA/NCEP GFS 10 m wind"],
        source: [NC_CHAR, "NOAA/NCEP Global Forecast System (GFS) 0.25 degree analysis, NOAA Open Data Dissemination (NODD)"],
        history: [NC_CHAR, "Converted from GRIB2 by leaflet.easyvelocity tools/grib2-to-netcdf.js" +
            (stride > 1 ? ", every " + stride + "th grid point" : "") + (pack ? ", packed to 16-bit integers" : "")]
    });
    w.int(0x0B); w.int(variables.length);
    variables.forEach((v, k) => {
        w.name(v.name);
        w.int(v.dims.length);
        for (const d of v.dims) w.int(d);
        w.attributes(v.attrs);
        w.int(v.type);
        w.int(v.vsize);
        w.int(begins[k]);
    });
    return w.toBuffer();
}

// The header length does not depend on the `begin` values, so measure it once, then lay out the data:
// fixed-size variables first, then the records (time, U, V of step 0; time, U, V of step 1; ...).
const headerLength = header(variables.map(() => 0)).length;
const begins = [];
let offset = headerLength;
for (const v of variables) if (!v.isRecord) { begins.push(offset); offset += v.vsize; }
const recordStart = offset;
for (const v of variables) if (v.isRecord) { begins.push(offset); offset += v.vsize; }
// (begins is in variable order because the fixed variables come first in `variables`)

const out = new Writer();
out.bytes(header(begins));
out.values(NC_DOUBLE, latitudes);
out.values(NC_DOUBLE, longitudes);
if (out.length !== recordStart) throw new Error("layout error");

const grid = (field) => {
    const list = new Array(ni * nj);
    for (let j = 0; j < nj; j++) {
        for (let i = 0; i < ni; i++) {
            const x = field.values[rowOf(j) * g.ni + i * stride];
            list[j * ni + i] = x !== x ? FILL : pack ? Math.max(-32766, Math.min(32767, Math.round(x / SCALE))) : x;
        }
    }
    return list;
};
for (const s of steps) {
    out.values(NC_DOUBLE, [s.u.validTime / 1e3]);
    out.values(dataType, grid(s.u));
    out.values(dataType, grid(s.v));
}

fs.writeFileSync(output, out.toBuffer());
console.log(output + ": " + steps.length + " time steps, " + ni + " x " + nj + " grid, " +
    Math.round(out.length / 1024) + " KB (" + steps.map((s) => new Date(s.u.validTime).toISOString()).join(", ") + ")");
