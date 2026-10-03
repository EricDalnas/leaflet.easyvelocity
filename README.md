# leaflet.easyvelocity

Leaflet plugin for gridded velocity fields: wind, ocean currents, and other U/V data. The demo uses NOAA GRIB2 and a built-in synthetic field. Plain browser JavaScript; using it needs no build step and no npm.

**Proprietary software. Not open source.** All rights reserved, see [LICENSE](LICENSE).

The package name follows the existing `leaflet.<name>` naming convention: `leaflet.easyvelocity`.
The canonical API is `L.easyVelocity(...)` (also exposed as `L.EasyVelocity`). The old `L.windField(...)` and `L.timeDimension.layer.windField(...)` names remain as compatibility aliases.

## Use it in a page

Load Leaflet, then (optionally) Leaflet.TimeDimension, then the one built file:

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="dist/leaflet.easyvelocity.js"></script>
<script>
    const map = L.map("map").setView([40, -75], 5);
    L.easyVelocity({ source: "test" }).addTo(map);
</script>
```

## Run the example

1. Open this folder in VS Code (Live Server extension installed).
2. Right-click `examples/index.html` → **Open with Live Server**.

The example starts with `source: "test"`. Use the **Source** dropdown for live NOAA data, archived storms, or a custom GRIB2 URL.
URL options: `?preferCanvas=1` runs the host map with Leaflet's canvas renderer (the wind layer is unaffected); `?dist` loads `dist/leaflet.easyvelocity.js` instead of the individual `src/` files.

## Project layout (and where to start reading)

Every file in `src/` starts with a comment block explaining its concepts for readers new to GRIB2 / weather data.

```
dist/
  leaflet.easyvelocity.js     the single built file: all of src/ joined in load order (generated)
src/                  the readable source, one concern per file
  grib2-unpack.js     DATA: packed bits -> numbers (bit reader, packing formulas)
  grib2-reader.js     DATA: walks a GRIB2 message, reads its metadata, calls the unpacker
  wind-data.js        DATA: WindData grid + bilinear getVector(lat, lon)
  test-field.js       DATA: synthetic field for source: "test"
  grib-loader.js      DATA: URL -> WindData (.idx + Range requests, or streaming)
  time-sources.js     DATA: [{time, source}] list -> times + timeSource for a time slider
  gfs.js              DATA: NOAA GFS / GEFS URL and forecast-time helpers
  frame-cache.js      LAYER mixin: load/cache one frame per time step, setTime()
  speed-field.js      LAYER mixin: colour scale, screen-aligned wind grid, speed field painting
  particles.js        LAYER mixin: the animated particles
  time-dimension.js   optional: glue to Leaflet.TimeDimension
  leaflet.easyvelocity.js     the L.easyVelocity layer: options, public API, canvas placement. Loads LAST.
examples/
  index.html          demo page: map, controls, legend, TimeDimension slider
  data/               archived NOAA GFS sample files for the demo (see examples/data/NOTICE.txt)
tools/
  build-dist.js       optional maintainer script that regenerates dist/ (plain Node, no dependencies)
package.json          metadata only (private, UNLICENSED); not needed to use the plugin
LICENSE               proprietary licence notice
```

`dist/leaflet.easyvelocity.js` is generated from `src/`: after changing `src/`, run `node tools/build-dist.js` (or `npm run build`). Nothing else is installed and nothing is minified.

Suggested reading order for the GRIB2 side: `grib2-reader.js` (the format) -> `grib2-unpack.js` (the packing) -> `grib-loader.js` (fetching). For the drawing side: `leaflet.easyvelocity.js` -> `speed-field.js` -> `particles.js`.

When loading the `src/` files individually, order matters, see `examples/index.html`: Leaflet, optional TimeDimension, the `src/` files in the order above, with `leaflet.easyvelocity.js` last. If one is missing or out of order, `leaflet.easyvelocity.js` throws an error that names it.

The `DATA` files use no Leaflet or DOM, so they also run in Node or a Web Worker. They share one namespace object, `EasyVelocityParts`.

## Usage

```js
const wind = L.easyVelocity({
    source: "test",                    // or a GRIB2 URL, e.g. L.easyVelocity.gfsUrl()
    particleCount: 4000,
    particleSpeed: 1.0,
    particleSize: 1,
    particleOpacity: 0.8,
    trailLength: 0.9,
    showParticles: true,
    showSpeedField: true,
    opacity: 0.75,                     // speed-field opacity
    colorScale: [[0, "#264b96"], [10, "#6fd05c"], [25, "#d62839"]]   // [m/s, css color]
}).addTo(map);

wind.start();  wind.stop();  wind.reload();
wind.setSource(url);
wind.setOptions({ particleCount: 8000 });
wind.getVector(lat, lon);              // { u, v, speed } or null (no data)
wind.getLegend();                      // { min, max, units, stops }
```

Events: `loading`, `progress`, `load`, `error`, `start`, `stop`.
GRIB options: `level` (default `10`) and `levelType` (default `103`, height above ground in metres; for `100`, pressure levels, `level` is in hPa, e.g. `850`).
Helper: `L.easyVelocity.gfsUrl({ resolution: "0p25", forecastHour: 0 })`.

## Time dimension (Leaflet.TimeDimension slider/player)

Load [Leaflet.TimeDimension](https://github.com/socib/Leaflet.TimeDimension) (and `iso8601-js-period`) **before** `leaflet.easyvelocity.js`, give the layer a `timeSource`, and add it through the wrapper instead of `addTo(map)`:

```js
const gfs = L.easyVelocity.gfsForecast({ from: 0, to: 48, step: 3 });   // latest GFS cycle, f000..f048

const map = L.map("map", {
    timeDimension: true,
    timeDimensionOptions: { times: gfs.times, currentTime: gfs.times[0], loadingTimeout: 30000 },
    timeDimensionControl: true
});

const wind = L.easyVelocity({ timeSource: gfs.timeSource });   // (timeMs) => GRIB2 URL | "test" | WindData
L.timeDimension.layer.easyVelocity(wind).addTo(map);
```

- The wrapper calls `wind.setTime(ms)` when the slider/player changes time; `wind.prefetchTime`, `isTimeReady` and `setTime` also work without TimeDimension.
- Frames are cached (`cacheFrames`, default 6, grown automatically for the player buffer) and prefetched, so playback does not re-decode. Particles keep flowing across frames; only the vector field changes.
- `source: "test"` is time-aware too: the synthetic systems drift east relative to the first time shown.
- `timeSource` may return any URL, e.g. a different file per time; the layer does not care about the time scale. For a single static file, omit `timeSource` and the time slider has no effect.
- Raise `loadingTimeout` (TimeDimension's default is 3 s) for large downloads.
- Switching data at runtime: `wind.setOptions({ timeSource })`, then `map.timeDimension.setAvailableTimes(times, "replace")`.

## Demo data sources

The Source dropdown in `examples/index.html` is built from the `datasets` object in its script; add an entry to add a source.

| Group | Source | Notes |
|---|---|---|
| Synthetic | Test field, 24 h | In-browser generator, no network |
| Live NOAA | GFS 10 m, next 48 h | Newest cycle on AWS, 0.25°, 3-hourly |
| Live NOAA | GFS 10 m, last 2 days | Analyses (forecast hour 0) of the last 8 cycles |
| Live NOAA | GFS 850 hPa, 250 hPa (jet stream) | `level: 850 / 250, levelType: 100` |
| Live NOAA | GFS 10 m, 1° grid, next 5 days | ~16x smaller downloads |
| Live NOAA | GEFS ensemble mean 10 m, next 5 days | 0.5°, same decoder |
| Archived | Hurricane Ian (28 Sep 2022), Winter Storm Elliott (23 Dec 2022) | Files in `examples/data/`, no network |

"Live" entries are computed from the clock when the page loads (`gfsCycle` = now minus 5 h, floored to 00/06/12/18 UTC), so they never go stale.
If the newest cycle is not published yet, the first request fails: reload a little later.

Helpers (all on `L.easyVelocity`): `gfsUrl`, `gfsForecast`, `gfsAnalyses`, `gefsMeanUrl`, `gefsMeanForecast`, and `timeList([{ time, source }])`, which turns any list of dated files into `{ times, timeSource }` for the time slider.

**Not usable (yet):** ECMWF open data (CC-BY-4.0, on AWS with CORS) is packed with CCSDS (template 5.42), which the decoder rejects; see the limitations below.

**Licensing of the bundled files:** NOAA data from NODD are open to the public; NOAA requests attribution for unaltered data and no implied endorsement. Details in `examples/data/NOTICE.txt`. The example adds a "Wind data: NOAA/NCEP…" attribution to the map when a NOAA source is selected. This is separate from the plugin's own proprietary licence.

## Where the GRIB2 URL goes

`source` in the `L.easyVelocity({...})` call in `examples/index.html`, or `wind.setSource(url)` at runtime.

## Data loading vs. rendering

- **Data side** (`Grib2`, `WindData`, loaders): turns a source into a `WindData` — a regular lat/lon grid of U/V with `getVector(lat, lon)` (bilinear, longitude wrapping, `null` for missing).
  The GRIB reader inspects each message's metadata (discipline 0, category 2, number 2/3 = UGRD/VGRD, level type 103, level 10, valid time, grid) rather than assuming positions.
  For NOAA files it first reads the `.idx` and downloads only the two needed messages with `Range` requests (about 2 MB instead of ~500 MB); otherwise it streams the file and stops once a matching U/V pair is found.
- **Rendering side** (`L.EasyVelocity`): owns two `<canvas>` elements in the map pane (speed field and particles); it never uses `L.canvas()`/SVG. On move end / zoom / resize it only re-samples the cached `WindData` onto a screen-aligned grid; nothing is reloaded or re-decoded. `"test"` and a GRIB2 URL go through the identical renderer.

## Limitations

- **CORS**: the browser needs the server to send `Access-Control-Allow-Origin` (and allow the `Range` header for the fast path). The AWS bucket `noaa-gfs-bdp-pds` does (checked with GET, `Range` and preflight). `nomads.ncep.noaa.gov` may not; if a fetch is blocked the error message says so. Workaround: host the file yourself or use a proxy.
- **Large files**: if a server has no `.idx`/Range support, the stream fallback may download most of a ~500 MB GFS file. Prefer the AWS URL or a pre-filtered file (e.g. a NOMADS filter or your own subset with only UGRD/VGRD 10 m).
- **Decoder scope**: GRIB2 edition 2, regular lat/lon grid (template 3.0), simple and complex packing with spatial differencing (5.0/5.2/5.3), bitmaps. JPEG2000/PNG-packed (5.40/5.41) and projected grids are rejected with an explicit error. Verified against a real GFS 0.25° file's 10 m UGRD/VGRD.
- The screen-grid sampling assumes the default Web Mercator CRS for speed; other CRSs use a slower per-cell path.
- The test field includes a small "no data" hole (near 46°N, 62°W) to show particles disappearing and respawning.

## License

Proprietary, all rights reserved. See [LICENSE](LICENSE), where `[OWNER NAME]` must be filled in. The plugin contains no third-party code; Leaflet, Leaflet.TimeDimension and map tiles used by the example page are loaded from their own sources under their own terms, and the sample data under `examples/data` is NOAA data (see its `NOTICE.txt`).
