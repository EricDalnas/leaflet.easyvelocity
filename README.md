# leaflet.easyvelocity

A Leaflet layer for animated velocity fields: wind, ocean currents, or any gridded U/V data. It reads GRIB2 and NetCDF files directly in the browser, paints a colored speed map with flowing particles on top, and plays through time with Leaflet.TimeDimension. Plain JavaScript, no build step needed.

**Proprietary software, all rights reserved.** See [LICENSE](LICENSE).

Live demo: [ericdalnas.github.io/leaflet.easyvelocity](https://ericdalnas.github.io/leaflet.easyvelocity/examples/)

## Quick start

Load Leaflet, optionally Leaflet.TimeDimension, then the plugin:

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="dist/leaflet.easyvelocity.js"></script>
<script>
    const map = L.map("map").setView([40, -75], 5);

    // Any GRIB2 or NetCDF file with U/V wind (or current) data.
    L.easyVelocity({ source: "https://example.com/data/wind.grib2" }).addTo(map);
</script>
```

The source can be any URL the browser is allowed to fetch, for example `"data/wind.grib2"` or `"https://example.com/currents.nc"`. Use `source: "test"` for a generated sample field that needs no download.

`L.EasyVelocity` is the class behind `L.easyVelocity()`. The older names `L.windField`, `L.timeDimension.layer.windField` and `WindData` still work.

## Running the demo

Serve the folder with any local web server (VS Code's Live Server works) and open `examples/index.html`. Opening the file straight from disk won't work, since browsers block `fetch()` on `file://` pages.

The demo starts on the latest GFS surface wind forecast. Other data is in the Source list, grouped by file format. The settings panel can be dragged, resized and collapsed, and on phones it sits along the top.

Add `?dist` to the URL to load the built file instead of the separate source files, or `?preferCanvas=1` to run the map with Leaflet's canvas renderer.

## Options and methods

```js
const layer = L.easyVelocity({
    source: "https://.../wind.grib2",  // GRIB2 or NetCDF URL, or "test" for generated sample data
    format: "auto",                    // "auto" (NetCDF for .nc URLs, else GRIB2), "grib2" or "netcdf"
    particleCount: 4000,
    particleSpeed: 1.0,
    particleSize: 1,
    particleOpacity: 0.8,
    trailLength: 0.9,
    showParticles: true,
    showSpeedField: true,
    opacity: 0.75,                     // speed-field opacity
    colorScale: [[0, "#264b96"], [10, "#6fd05c"], [25, "#d62839"]],  // [m/s, css color]
    fadeBelow: 0,                      // fade the speed map out below this speed (m/s); 0 = off
    units: "m/s"                       // "m/s", "kt", "mph" or "km/h" for the legend and readouts
}).addTo(map);

layer.start();  layer.stop();  layer.reload();
layer.setSource(url);
layer.setOptions({ particleCount: 8000 });
layer.getVector(lat, lon);             // { u, v, speed } in m/s, or null where there's no data
layer.getBounds();                     // area covered by the data, e.g. map.fitBounds(layer.getBounds())
layer.getLegend();                     // { min, max, units, factor, fadeBelow, stops } in display units
layer.toDisplaySpeed(metresPerSecond); // converts to the chosen units
```

Events: `loading`, `progress`, `load`, `error`, `start`, `stop`.

`level` and `levelType` pick the height. The default is 10 m above ground (`levelType: 103`); for pressure levels use `levelType: 100` with `level` in hPa, e.g. `850`.

Speeds are always m/s internally, including `colorScale` and `fadeBelow`. `units` only changes what the legend and `toDisplaySpeed()` report.

## NetCDF

NetCDF works anywhere a GRIB2 URL does. URLs ending in `.nc`, `.nc3`, `.cdf` or `.netcdf`, or containing `accept=netcdf`, are read as NetCDF automatically; for anything else set `format: "netcdf"`.

```js
L.easyVelocity({ source: "data/storm.nc" });                                   // first time step
L.easyVelocity({ source: "data/storm.nc#time=2022-09-28T12:00:00Z" });         // nearest time step
L.easyVelocity({ source: "https://.../currents.nc#u=water_u&v=water_v" });     // pick the variables
```

- The `#...` part isn't sent to the server; it just says what to read from the file. Without `#time`, the first time step is shown.
- A file with several time steps is downloaded once and reused for each of them.
- `L.easyVelocity.netcdfTimes(url)` returns a promise of the file's time steps (ms), handy for filling a time slider.
- U and V are found by their CF `standard_name` (`eastward_wind`, `northward_wind`, sea-water velocity, ...) or by common names such as `ugrd10m`, `u10`, `UGRD_10maboveground`, `water_u` or `uo`. If nothing matches, the error lists what the file contains.
- The grid must be regular latitude/longitude, with those as the last two dimensions. A height or pressure dimension is matched against `level`.
- `scale_factor`, `add_offset`, `_FillValue` and `missing_value` are applied.

### NetCDF-4

NetCDF-4 files are HDF5 inside. To read them, include [h5wasm](https://github.com/usnistgov/h5wasm) on the page:

```html
<script src="https://cdn.jsdelivr.net/npm/h5wasm@0.10.3/dist/iife/h5wasm.js"></script>
```

h5wasm is a separate library under the NIST and HDF5 (BSD-style) licences and isn't bundled with the plugin. Classic NetCDF and GRIB2 don't need it.

## Animating over time

Load [Leaflet.TimeDimension](https://github.com/socib/Leaflet.TimeDimension) (and `iso8601-js-period`) before the plugin, give the layer a `timeSource`, and add it through the wrapper instead of `addTo(map)`:

```js
// One file per time step; any list of dated URLs works.
const forecast = L.easyVelocity.timeList([
    { time: "2026-10-18T00:00:00Z", source: "https://example.com/data/wind-00z.grib2" },
    { time: "2026-10-18T06:00:00Z", source: "https://example.com/data/wind-06z.grib2" },
    { time: "2026-10-18T12:00:00Z", source: "https://example.com/data/wind-12z.grib2" }
]);

const map = L.map("map", {
    timeDimension: true,
    timeDimensionOptions: { times: forecast.times, currentTime: forecast.times[0], loadingTimeout: 10000 },
    timeDimensionControl: true
});

const layer = L.easyVelocity({ timeSource: forecast.timeSource });   // (timeMs) => URL, "test" or VelocityData
L.timeDimension.layer.easyVelocity(layer).addTo(map);
```

- `layer.setTime(ms)`, `prefetchTime` and `isTimeReady` also work without TimeDimension.
- Decoded frames are kept in memory (`cacheFrames`, default 6, and more while they fit in `cacheMemory`, default 200 MB), so a short loop plays back without reloading. Particles keep flowing from one frame to the next.
- `timeSource` can also be your own function, e.g. one that builds the URL for each time.
- TimeDimension's default `loadingTimeout` is 3 seconds; raise it for large downloads.
- To switch data, call `layer.setOptions({ timeSource })` and then `map.timeDimension.setAvailableTimes(times, "replace")`.

## Demo data

The Source list is built from the `datasets` object in `examples/index.html`; add an entry there to add a source. The URLs for NOAA's live GFS and GEFS runs are built by `examples/noaa.js`, a small demo helper that isn't part of the plugin.

| Format | Source | Notes |
|---|---|---|
| GRIB2 | GFS 10 m wind, next 48 h | Latest NOAA GFS run on AWS, 0.25°, every 3 hours |
| GRIB2 | GFS 10 m wind, last 2 days | Analyses from the last 8 runs |
| GRIB2 | GFS 850 hPa and 250 hPa (jet stream) | Upper-level winds |
| GRIB2 | GFS 1° grid, 5 days | Much smaller downloads |
| GRIB2 | GEFS ensemble mean, 5 days | Average of the GFS ensemble, 0.5° |
| GRIB2 | Hurricane Ian (28 Sep 2022), Winter Storm Elliott (23 Dec 2022) | Included in `examples/data/` |
| NetCDF | GFS 10 m wind via ERDDAP, next 48 h | From the [PacIOOS ERDDAP](https://pae-paha.pacioos.hawaii.edu/erddap/griddap/ncep_global.html) server, 0.5° |
| NetCDF | Hurricane Ian | The Ian data above as a single NetCDF file, 0.5° |
| NetCDF-4 | Blended Sea Winds, Hurricane Ian | NOAA NCEI satellite and model ocean winds, 0.25° |
| Synthetic | Test field | Generated in the browser, no network |

Live sources are worked out from the current time when the page loads. If the newest GFS run isn't published yet, the first request can fail; try again a little later.

ECMWF open data isn't supported yet: it uses CCSDS compression, which the GRIB2 decoder doesn't handle.

NOAA data is free to use. NOAA asks for attribution and no implied endorsement; the demo shows the credit on the map. Details are in `examples/data/NOTICE.txt`.

## How it works

The data side turns a source into a `VelocityData`: a regular lat/lon grid of U and V with `getVector(lat, lon)`. For NOAA GRIB2 files it reads the small `.idx` index first and downloads only the two fields it needs with HTTP Range requests, about 2 MB instead of the full ~500 MB file. Other GRIB2 files are streamed until U and V turn up. NetCDF files are downloaded whole.

The layer draws onto two canvases of its own (the speed map and the particles). Panning and zooming only resample the cached data onto the screen; nothing is downloaded or decoded again.

## Project layout

```
dist/leaflet.easyvelocity.js   all of src/ in one file (generated)
src/
  grib2-unpack.js       GRIB2 bit unpacking
  grib2-reader.js       GRIB2 message parsing
  netcdf-reader.js      NetCDF classic reader
  netcdf4-reader.js     NetCDF-4 support (uses h5wasm)
  velocity-data.js      the U/V grid and interpolation
  test-field.js         synthetic test data
  grib-loader.js        loading GRIB2 from a URL; picks the format
  netcdf-loader.js      loading NetCDF from a URL
  time-sources.js       time lists for the slider
  frame-cache.js        per-time-step loading and caching
  speed-field.js        color scale and speed map
  particles.js          particle animation
  time-dimension.js     Leaflet.TimeDimension integration
  leaflet.easyvelocity.js   the layer itself (load last)
examples/               demo page, NOAA URL helpers (noaa.js) and sample data
tools/
  build-dist.js         rebuilds dist/
  grib2-to-netcdf.js    converts GRIB2 wind files to NetCDF
```

After changing anything in `src/`, run `node tools/build-dist.js` (or `npm run build`). When loading the `src/` files separately, keep the order used in `examples/index.html`; the layer reports any file that's missing or out of order.

The data files don't depend on Leaflet or the DOM, so they also run in Node or a Web Worker.

## Limitations

- **CORS**: the data server must allow cross-origin requests. NOAA's AWS bucket does; `nomads.ncep.noaa.gov` may not. If a request is blocked, host the file yourself or use a proxy.
- **Large files**: without an `.idx` index or Range support, a GRIB2 stream may download most of a large file. NetCDF files are always downloaded whole, so request a subset from the server where you can.
- **GRIB2**: edition 2, regular lat/lon grids, simple and complex packing. JPEG2000, PNG and CCSDS packing and projected grids aren't supported.
- **NetCDF**: classic (CDF-1, CDF-2, CDF-5) and NetCDF-4 via h5wasm; regular lat/lon grids only.
- Screen sampling is fastest with Leaflet's default Web Mercator projection; other projections work but are slower.

## License

Proprietary, all rights reserved; see [LICENSE](LICENSE) (fill in `[OWNER NAME]`). The plugin contains no third-party code. Leaflet, Leaflet.TimeDimension, h5wasm and the map tiles used by the demo come from their own sources under their own terms. The sample data in `examples/data` is from NOAA (see `NOTICE.txt`).
