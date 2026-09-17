# WayPoint Route Logger

A Leaflet/OpenStreetMap route planning app with granular GPS trip recording for support-work transport.

## Actual trip recorder

The planner now includes an **Actual trip recorder** panel. It records successive high-accuracy GPS fixes, draws the driven track on the Leaflet map, and calculates actual distance from the recorded GPS segments.

Recorded trip data includes:

- start/end time and elapsed time
- latitude/longitude fixes with timestamps
- reported GPS accuracy
- speed and heading when the device provides them
- cumulative actual distance
- manually marked stops
- planned route distance snapshot, when a planned route exists
- actual-vs-planned distance variance
- trip notes

Trips are stored locally on the device in IndexedDB and can be reopened on the map.

## Exports

Saved trips can be exported as:

- **GPX** — suitable for re-importing into the planner and other GPS tools
- **GeoJSON** — includes the route line, timestamps, GPS accuracy/speed arrays, and marked stops
- **CSV** — one row per recorded GPS point for detailed analysis

## Using it

1. Open `planner.html`.
2. Optionally build/load a planned route.
3. Open **Trip & map controls → Actual trip recorder**.
4. Press **Start trip**.
5. Leave WayPoint visible while driving for the most reliable browser-based GPS logging.
6. Use **Mark stop** for pickup/drop-off or activity stops.
7. Press **Stop & save** when the trip is complete.
8. Select the saved trip to show it on the map or export it.

By default, pressing the existing **Start nav** button also starts the recorder when a planned route is present. This can be disabled in the recorder panel.

## Android background-location limitation

This is a browser/PWA implementation. Android may throttle or suspend browser geolocation when WayPoint is backgrounded, especially if Google Maps is brought to the foreground. The recorder requests a screen wake lock while active, but that does not give a web app unrestricted background-location access.

For dependable logging, keep WayPoint in the foreground. If continuous logging while another navigation app is foregrounded becomes essential, the next step is an Android wrapper/native build with proper background-location support.

## PWA

The manifest now launches `planner.html`, uses the repository's actual icon paths, and the service worker caches the planner plus the trip-recorder module.
