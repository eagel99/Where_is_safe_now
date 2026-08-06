# Third-party notices

This project is MIT licensed. It uses the following npm dependencies according to their respective licenses:

- `axios`, MIT, https://github.com/axios/axios
- `dotenv`, BSD-2-Clause, https://github.com/motdotla/dotenv
- `express`, MIT, https://github.com/expressjs/express
- `helmet`, MIT, https://github.com/helmetjs/helmet
- `leaflet`, BSD-2-Clause, https://github.com/Leaflet/Leaflet
- `mqtt`, MIT, https://github.com/mqttjs/MQTT.js
- `pino`, MIT, https://github.com/pinojs/pino
- `ws`, MIT, https://github.com/websockets/ws

## Vendored data

`data/cities.json` is the city metadata file from
[`eladnava/pikud-haoref-api`](https://github.com/eladnava/pikud-haoref-api), Apache-2.0.
The upstream license text is kept alongside it as `data/cities.json.LICENSE`.

Only the data file is vendored, not the package. The package depends on the
retired `request` HTTP client, which carries unpatched critical advisories
(SSRF in `request`, unsafe multipart boundaries in `form-data`) with no fixed
release available. This project needs the coordinates, shelter countdown times
and area names, all of which live in that one JSON file, so it is copied in
under the Apache-2.0 terms and the dependency is not installed. Refresh it by
copying the file from a newer release of the upstream package.

## Reviewed but not copied

The following repositories were reviewed as references, but their GPL or AGPL source code and data were not copied into this project:

- `dmatik/oref-alerts-proxy-ms`, GPL-3.0
- `maorcc/oref-map`, AGPL-3.0
- `idodov/RedAlert`, GPL-3.0

`amitfin/oref_alert` is MIT licensed and was reviewed to understand source behavior and category semantics. The implementation in this repository is independently written for Node.js.

The Oref, mobile push and Tzeva Adom endpoints are third-party network services. Their availability, terms and payload formats may change independently of this software.
