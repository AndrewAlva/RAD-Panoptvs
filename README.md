# RAD Panoptvs

WebSocket + MJPEG camera streaming server. Mobile browsers send live video frames; TouchDesigner (or any HTTP client) consumes them as MJPEG streams.

## Quick Start

```bash
npm install
npm start
```

Default port: **3000**. Set `PORT=<n>` environment variable to change it.

## Admin Panel

Open `http://localhost:3000/admin` in a desktop browser.

**Password:** `td2025`

The admin page shows:
- A QR code linking to the server's local network IP — share this with participants on the same WiFi.
- A live list of connected cameras with their MJPEG stream URLs.

## Mobile Camera (session.html)

Mobile devices that scan the QR code (or visit `http://<localIP>:3000/`) are served `session.html` automatically via server-side User-Agent detection. The page:
1. Requests camera permission.
2. Shows a full-screen live preview.
3. Connects via WebSocket and streams JPEG frames at ~15 fps.

## TouchDesigner Integration

### Receiving camera updates via WebSocket DAT

1. Add a **WebSocket DAT** node.
2. Set **Network Address** to `localhost` and **Port** to `3000`.
3. In the DAT's **Active** script (or on Connect callback), send:
   ```json
   {"type":"admin-announce"}
   ```
4. The server responds with (and re-sends on any camera change):
   ```json
   {"type":"camera-list","cameras":[{"id":"…","label":"Camera 1234","streamUrl":"http://192.168.x.x:3000/mjpeg/<id>"}]}
   ```
5. Parse the JSON in TouchDesigner to get the list of `streamUrl` values.

### Consuming MJPEG streams via Movie In TOP

For each camera in the list, add a **Movie In TOP**:
- Set **File** (or **URL**) to the `streamUrl`, e.g. `http://192.168.x.x:3000/mjpeg/<cameraId>`.
- Enable **Follow File** or set **Play Mode** to `Sequential` so it polls continuously.

MJPEG streams update in real time as frames arrive — no polling delay.

## Architecture

```
Mobile browser  →  WebSocket (frames)  →  Node server  →  MJPEG stream  →  TouchDesigner / browser
Desktop browser →  WebSocket (admin)   →  Node server  →  camera-list JSON updates
```

- `server.js` — Express + ws + MJPEG server with device detection and cookie auth
- `public/session.html` — Mobile camera page (no admin data ever sent here)
- `public/admin.html` — Desktop admin page (QR code + live camera list)

## Known Limitations

- MJPEG over HTTP is efficient but has higher latency than WebRTC (~100–300 ms depending on network and frame rate).
- Frame rate is capped at ~15 fps by the 66 ms `setInterval` on the mobile page. Reduce the interval for higher frame rates at the cost of bandwidth.
- The admin cookie is valid for the browser session only (no `maxAge` set); it clears on browser close.
- Safari on iOS requires `playsInline` and `muted` on the `<video>` element (both set).
- The server exposes MJPEG streams without authentication. Restrict access at the network level if needed.
- `ADMIN_PASSWORD` is hardcoded in `server.js` as the constant `td2025`. Change it before deployment.
