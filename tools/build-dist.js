/*
 * tools/build-dist.js — joins the files in src/ into the single script dist/leaflet.easyvelocity.js
 *
 * OPTIONAL, for maintainers only: plain Node, no dependencies, nothing is installed or minified.
 *   node tools/build-dist.js        (or: npm run build)
 * Users of the plugin never run it; they load dist/leaflet.easyvelocity.js with one <script> tag.
 *
 * The order matters and is the same as the <script> order in examples/index.html:
 * data side, layer side, optional TimeDimension glue, and the layer itself last.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const files = [
    "grib2-unpack.js",
    "grib2-reader.js",
    "netcdf-reader.js",
    "netcdf4-reader.js",
    "velocity-data.js",
    "test-field.js",
    "grib-loader.js",
    "netcdf-loader.js",
    "time-sources.js",
    "gfs.js",
    "frame-cache.js",
    "speed-field.js",
    "particles.js",
    "time-dimension.js",
    "leaflet.easyvelocity.js"
];

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const banner = "/*! leaflet.easyvelocity v" + version + " | Proprietary, all rights reserved. See LICENSE. */\n" +
    "/* Built from src/ by tools/build-dist.js: edit the files in src/, not this file. */\n";

const body = files.map((name) => {
    const source = fs.readFileSync(path.join(root, "src", name), "utf8").replace(/\r\n/g, "\n");
    return "\n/* ===== src/" + name + " ===== */\n" + source;
}).join("");

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "leaflet.easyvelocity.js"), banner + body);
console.log("dist/leaflet.easyvelocity.js: " + files.length + " files, " + Math.round((banner + body).length / 1024) + " KB");
