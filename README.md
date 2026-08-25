# geo-trigger

A lightweight, local-first PWA for GPS geofencing and webhook automation, with configurable zones stored directly in the browser.

## Overview

**geo-trigger** monitors the device's GPS position and triggers HTTP webhooks when the device enters or leaves configurable geographic zones.

The project is designed to be:

* **Local-first** — configuration is stored locally in the browser.
* **Lightweight** — no backend or database required.
* **Installable** — designed as a Progressive Web App (PWA).
* **Privacy-friendly** — GPS data stays on the device unless explicitly sent to a configured webhook.
* **Dependency-free** — built with standard Web APIs wherever possible.

A primary use case is testing GPS-based automation in a vehicle, such as triggering a garage door webhook when arriving home.

## Features

* GPS position tracking using the browser Geolocation API
* Configurable circular geofences
* Configurable latitude and longitude
* Configurable zone diameter
* Configurable webhook URL
* Webhook triggered when entering a zone
* Optional exit events
* Multiple geofences
* Local persistence using browser storage
* Service Worker support
* PWA installation
* Works offline for the application itself
* No account or remote database required

## How it works

```text
                 Browser GPS
                     │
                     ▼
              Current position
                     │
                     ▼
              Geofence engine
                     │
          ┌──────────┴──────────┐
          │                     │
       Outside               Inside
          │                     │
          │                  trigger
          │                     │
          │                     ▼
          │                  Webhook
          │                     │
          └─────────────────────┘
```

The browser obtains the current GPS position using:

```javascript
navigator.geolocation.watchPosition()
```

For each position update, the distance between the device and each configured geofence is calculated.

When the device crosses the geofence boundary, a webhook can be triggered.

## Configuration

A geofence consists of three main parameters:

```json
{
  "latitude": 47.2356,
  "longitude": 0.7342,
  "diameter": 500,
  "webhook": "https://example.com/webhook"
}
```

Multiple zones can be configured.

For example:

```text
Home
 ├── Latitude: 47.2356
 ├── Longitude: 0.7342
 ├── Diameter: 500 m
 └── Webhook: https://example.com/home

Work
 ├── Latitude: 47.3912
 ├── Longitude: 0.6891
 ├── Diameter: 200 m
 └── Webhook: https://example.com/work
```

## URL configuration

Zones can also be configured through URL parameters.

Example:

```text
https://example.com/?lat=47.2356&lon=0.7342&diameter=500&webhook=https%3A%2F%2Fexample.com%2Fwebhook
```

This makes it possible to create configuration links that can be opened directly on a device.

## Webhook payload

An entry event can send a JSON payload similar to:

```json
{
  "event": "enter",
  "latitude": 47.23561,
  "longitude": 0.73421,
  "accuracy": 12.4,
  "timestamp": "2026-08-25T18:00:00.000Z"
}
```

Exit events can use:

```json
{
  "event": "exit",
  "latitude": 47.23561,
  "longitude": 0.73421,
  "accuracy": 12.4,
  "timestamp": "2026-08-25T18:05:00.000Z"
}
```

## GPS accuracy and hysteresis

GPS measurements are inherently noisy.

To avoid repeated enter/exit events when the position fluctuates around the boundary, geo-trigger uses hysteresis.

For example:

```text
              Exit boundary
             ┌───────────────┐
             │               │
             │  Entry zone   │
             │   ┌───────┐   │
             │   │       │   │
             │   │   ●   │   │
             │   │       │   │
             │   └───────┘   │
             │               │
             └───────────────┘
```

The device must enter the inner boundary to trigger an entry event, and move sufficiently far outside the zone before an exit is detected.

This prevents GPS jitter from repeatedly triggering the webhook.

## Running locally

The application requires a secure context for geolocation and Service Workers.

For local development:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

For deployment, use HTTPS.

## Project structure

```text
geo-trigger/
├── index.html
├── sw.js
├── app.js
├── geofence.js
├── storage.js
├── webhook.js
├── style.css
├── manifest.json
└── icons/
```

The project is intentionally kept simple and can initially be implemented without a JavaScript framework or build system.

## Browser compatibility

geo-trigger relies on standard browser APIs:

* Geolocation API
* Service Worker API
* Web App Manifest
* Fetch API
* Local Storage / IndexedDB

Actual GPS behaviour depends heavily on the browser and device.

In particular, **background geolocation is subject to operating-system and browser restrictions**.

Keeping the PWA installed does not guarantee that GPS tracking will continue when the application is completely closed or suspended.

## Tesla use case

One of the motivations for this project is to evaluate the GPS capabilities of the Tesla browser for vehicle-based automation.

For example:

```text
Tesla GPS
    │
    ▼
geo-trigger
    │
    │  Enter home geofence
    ▼
Webhook
    │
    ▼
Home Assistant
    │
    ▼
Garage door
```

This allows GPS behaviour from the vehicle itself to be compared with traditional phone-based geofencing.

## Privacy

geo-trigger does not require a central server.

GPS coordinates are processed locally by the browser.

Coordinates are only sent externally when a configured webhook is triggered.

The project does not require:

* user accounts
* analytics
* cloud storage
* remote databases
* GPS tracking servers

## Roadmap

Potential future improvements:

* [ ] Interactive map
* [ ] Multiple geofences
* [ ] IndexedDB storage
* [ ] PWA installation
* [ ] Import/export configuration
* [ ] URL-based configuration
* [ ] Enter and exit webhooks
* [ ] Configurable hysteresis
* [ ] Webhook retry mechanism
* [ ] Webhook authentication
* [ ] Event history
* [ ] GPS accuracy filtering
* [ ] Configurable minimum dwell time
* [ ] Better background execution where supported
* [ ] Native Android/iOS geofencing integration

## License

License to be defined.
