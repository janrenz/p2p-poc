# TURN Server Setup Guide

## Why Use a TURN Server?

WebRTC connections can fail when:
- Both peers are behind NAT/firewall
- Symmetric NAT prevents direct connections
- Corporate firewalls block peer-to-peer traffic

A TURN (Traversal Using Relays around NAT) server relays traffic when direct P2P connections fail, ensuring connections work in difficult network scenarios.

## Option 1: Use a Free TURN Service

### Twilio STUN/TURN (Free Tier Available)
- Sign up at https://www.twilio.com/stun-turn
- Get credentials from dashboard
- Add to `app.js` ICE configuration

### Metered.ca (Free Tier)
- Sign up at https://www.metered.ca/stun-turn
- Get free TURN credentials
- Add to `app.js` ICE configuration

## Option 2: Self-Hosted TURN Server (coturn)

### Installation (Ubuntu/Debian)
```bash
sudo apt-get update
sudo apt-get install coturn
```

### Configuration

1. Edit `/etc/turnserver.conf`:
```conf
# Listen on all interfaces
listening-port=3478
listening-ip=0.0.0.0

# External IP (your server's public IP)
external-ip=YOUR_PUBLIC_IP

# Realm (can be your domain)
realm=yourdomain.com

# User credentials (username:password)
user=username:password

# Enable TURN relay
relay-ip=0.0.0.0

# Logging
log-file=/var/log/turn.log
verbose

# Security
no-cli
no-tls
no-dtls
```

2. Enable coturn service:
```bash
sudo systemctl enable coturn
sudo systemctl start coturn
```

3. Open firewall ports:
```bash
# UDP ports for STUN/TURN
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp  # TURN relay ports
```

### Testing Your TURN Server

Use this tool: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

Add your TURN server:
- URL: `turn:your-server.com:3478`
- Username: `username`
- Password: `password`

## Configuration in app.js

Update the ICE servers configuration in `createPeer()` and `handleOffer()`:

```javascript
config: {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:your-turn-server.com:3478',
            username: 'your-username',
            credential: 'your-password'
        }
    ]
}
```

## Environment Variables (Recommended)

For production, use environment variables:

```javascript
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

// Add TURN server if configured
if (process.env.TURN_SERVER_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
    ICE_SERVERS.push({
        urls: process.env.TURN_SERVER_URL,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_PASSWORD
    });
}
```

Then use `ICE_SERVERS` in SimplePeer config.

## Benefits

- ✅ Works behind NATs/firewalls
- ✅ Higher connection success rate
- ✅ Better reliability for production use
- ⚠️ TURN servers relay traffic (bandwidth cost)
- ⚠️ Slight latency increase (relay overhead)

## Monitoring

Check TURN server logs:
```bash
tail -f /var/log/turn.log
```

Monitor bandwidth usage if self-hosting.


