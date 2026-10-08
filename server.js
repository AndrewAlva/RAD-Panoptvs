const express = require('express');
const https = require('https');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const cookieParser = require('cookie-parser');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'td2025';
const COOKIE_SECRET = crypto.randomBytes(32).toString('hex');

// --- Local IP detection ---
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const entry of iface) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIP();
const BASE_URL = `https://${LOCAL_IP}:${PORT}`;

// --- Self-signed TLS cert (generated once at startup) ---
const pems = selfsigned.generate([{ name: 'commonName', value: LOCAL_IP }], {
  days: 365,
  algorithm: 'sha256',
  extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: LOCAL_IP }] }],
});

// --- State ---
// Map<cameraId, { label, ws, frameBuffer: Buffer|null, mjpegClients: Set<res> }>
const cameras = new Map();
const adminClients = new Set();

// --- Express setup ---
const app = express();
app.use(cookieParser(COOKIE_SECRET));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Device detection ---
function isMobile(userAgent = '') {
  return /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
}

// --- Route: / (root — device-aware) ---
app.get('/', (req, res) => {
  if (isMobile(req.headers['user-agent'])) {
    res.sendFile('session.html', { root: path.join(__dirname, 'public') });
  } else {
    res.redirect('/admin');
  }
});

// --- Admin auth middleware ---
function requireAdmin(req, res, next) {
  const signed = req.signedCookies['td_admin_session'];
  if (signed === 'authenticated') return next();
  res.redirect('/admin?auth=0');
}

// --- Route: GET /admin ---
app.get('/admin', (req, res) => {
  const signed = req.signedCookies['td_admin_session'];
  if (signed === 'authenticated') {
    res.sendFile('admin.html', { root: path.join(__dirname, 'public') });
  } else {
    const error = req.query.auth === '0' ? 'Invalid password.' : '';
    res.send(renderPasswordForm(error));
  }
});

// --- Route: POST /admin (password submission) ---
app.post('/admin', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.cookie('td_admin_session', 'authenticated', {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
    });
    res.redirect('/admin');
  } else {
    res.send(renderPasswordForm('Invalid password.'));
  }
});

function renderPasswordForm(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RAD Panoptvs — Admin Login</title>
<style>
  body { font-family: sans-serif; background: #fff; color: #111; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
  .box { border: 1px solid #ccc; padding: 2rem; border-radius: 8px; min-width: 280px; text-align: center; }
  h2 { margin-top: 0; }
  input[type=password] { width: 100%; padding: 0.5rem; font-size: 1rem; margin-bottom: 0.75rem; box-sizing: border-box; border: 1px solid #aaa; border-radius: 4px; }
  button { padding: 0.5rem 1.5rem; font-size: 1rem; cursor: pointer; }
  .error { color: red; margin-bottom: 0.75rem; }
</style>
</head>
<body>
<div class="box">
  <h2>Admin Login</h2>
  ${error ? `<p class="error">${error}</p>` : ''}
  <form method="POST" action="/admin">
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">Enter</button>
  </form>
</div>
</body>
</html>`;
}

// --- Route: GET /qrcode-data (used by admin.html to fetch QR + URL) ---
app.get('/qrcode-data', requireAdmin, async (req, res) => {
  try {
    const dataUrl = await qrcode.toDataURL(BASE_URL, { width: 300 });
    res.json({ qrDataUrl: dataUrl, url: BASE_URL });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// --- Route: GET /mjpeg/:cameraId ---
app.get('/mjpeg/:cameraId', (req, res) => {
  const { cameraId } = req.params;
  const cam = cameras.get(cameraId);
  if (!cam) {
    res.status(404).send('Camera not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    'Connection': 'close',
    'Pragma': 'no-cache',
  });

  cam.mjpegClients.add(res);

  // Send the latest buffered frame immediately if we have one
  if (cam.frameBuffer) {
    pushMjpegFrame(res, cam.frameBuffer);
  }

  req.on('close', () => {
    cam.mjpegClients.delete(res);
  });
});

function pushMjpegFrame(res, frameBuffer) {
  try {
    res.write(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.length}\r\n\r\n`
    );
    res.write(frameBuffer);
    res.write('\r\n');
  } catch (_) {
    // client disconnected
  }
}

// --- Camera helpers ---
function getCurrentCameraList() {
  return Array.from(cameras.entries()).map(([id, cam]) => ({
    id,
    label: cam.label,
    streamUrl: `${BASE_URL}/mjpeg/${id}`,
  }));
}

function notifyAdmins() {
  const payload = JSON.stringify({ type: 'camera-list', cameras: getCurrentCameraList() });
  for (const ws of adminClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function removeCamera(cameraId) {
  const cam = cameras.get(cameraId);
  if (cam) {
    // Close all MJPEG streams for this camera
    for (const res of cam.mjpegClients) {
      try { res.end(); } catch (_) {}
    }
    cameras.delete(cameraId);
  }
}

// --- HTTPS + WebSocket server ---
const server = https.createServer({ key: pems.private, cert: pems.cert }, app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.role = null;
  ws.cameraId = null;

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return;
    }

    if (data.type === 'admin-announce') {
      ws.role = 'admin';
      adminClients.add(ws);
      ws.send(JSON.stringify({ type: 'camera-list', cameras: getCurrentCameraList() }));
      return;
    }

    if (data.type === 'camera-announce') {
      ws.role = 'camera';
      ws.cameraId = data.id;
      cameras.set(data.id, {
        label: data.label || `Camera ${data.id.slice(0, 4)}`,
        ws,
        frameBuffer: null,
        mjpegClients: new Set(),
      });
      notifyAdmins();
      ws.send(JSON.stringify({ type: 'connected', id: data.id }));
      return;
    }

    if (data.type === 'frame' && data.cameraId && data.data) {
      const cam = cameras.get(data.cameraId);
      if (!cam) return;

      // Decode base64 to Buffer
      const buf = Buffer.from(data.data, 'base64');
      cam.frameBuffer = buf;

      // Push to all MJPEG subscribers
      for (const res of cam.mjpegClients) {
        pushMjpegFrame(res, buf);
      }
    }
  });

  ws.on('close', () => {
    if (ws.role === 'admin') {
      adminClients.delete(ws);
    } else if (ws.role === 'camera' && ws.cameraId) {
      removeCamera(ws.cameraId);
      notifyAdmins();
    }
  });

  ws.on('error', () => {
    // handled via close event
  });
});

server.listen(PORT, () => {
  console.log(`RAD Panoptvs running (HTTPS)`);
  console.log(`  Local:   https://localhost:${PORT}`);
  console.log(`  Network: ${BASE_URL}`);
  console.log(`  Admin:   https://localhost:${PORT}/admin  (password: ${ADMIN_PASSWORD})`);
  console.log(`  Share QR URL with mobile participants: ${BASE_URL}`);
  console.log(`  NOTE: Browsers will warn about the self-signed cert — click "Advanced > Proceed" to continue.`);
});
