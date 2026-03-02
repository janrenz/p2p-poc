# P2P File Sharing App - Quick Start Guide

## Prerequisites

- Node.js (v14 or higher)
- npm
- coturn (TURN server) - will be installed automatically by start script

## Installation

```bash
npm install
```

## Starting the Application

### Option 1: Start Both TURN Server and App (Recommended)

**Linux/macOS:**
```bash
./start.sh
```

**Cross-platform (Windows/macOS/Linux):**
```bash
npm run start:turn
```

This will:
- Check if coturn is installed (install if missing)
- Start the TURN server on port 3478
- Start the app server on port 3000
- Handle cleanup on exit (Ctrl+C)

### Option 2: Start App Only (No TURN Server)

```bash
npm start
```

Use this if you don't need TURN server (e.g., testing on same network).

## Accessing the App

Once started, open your browser to:
- **Main App:** http://localhost:3000
- **TURN Server:** localhost:3478 (for WebRTC)

## Configuration

### TURN Server Credentials

The app automatically uses local TURN server when running on localhost:
- **URL:** turn:localhost:3478
- **Username:** testuser
- **Password:** testpass

These match the configuration in `turnserver.conf`.

### Changing Ports

**App Server:**
```bash
PORT=8080 npm start
```

**TURN Server:**
Edit `turnserver.conf` and change `listening-port=3478`

## Troubleshooting

### TURN Server Won't Start

1. **Check if coturn is installed:**
   ```bash
   which turnserver
   ```

2. **Install manually:**
   - macOS: `brew install coturn`
   - Ubuntu/Debian: `sudo apt-get install coturn`

3. **Check logs:**
   ```bash
   tail -f turn.log
   ```

### Port Already in Use

If port 3000 or 3478 is already in use:
- Kill existing process: `lsof -ti:3000 | xargs kill`
- Or change port in `turnserver.conf` and use `PORT=8080 npm start`

### WebRTC Connection Issues

1. Check browser console for errors
2. Verify TURN server is running: `lsof -i :3478`
3. Test TURN server: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

## Production Deployment

For production:
1. Update `turnserver.conf` with your public IP
2. Change TURN credentials (don't use testuser/testpass!)
3. Configure firewall to allow ports 3478 (UDP) and 3000 (TCP)
4. Update `getICEServers()` in `app.js` with production TURN server URL

See `TURN_SERVER_SETUP.md` for detailed production setup.
