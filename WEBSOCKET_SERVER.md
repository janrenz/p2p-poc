# WebSocket Signaling Server Documentation

## Overview

The WebSocket server handles WebRTC signaling between peers. It's currently used with SimplePeer and can work alongside PeerJS for peer discovery.

## Current Setup

### Server Configuration
- **Port**: 3000 (same as Express server)
- **Path**: `/` (WebSocket upgrade on same port)
- **Library**: `ws` (Node.js WebSocket library)

### What It Does

1. **Peer Registration**
   - Clients register as 'sender' or 'receiver'
   - Auto-detection: if no sender exists, client becomes sender
   - Supports up to 30 receivers

2. **Signaling**
   - Forwards WebRTC offers/answers between peers
   - Handles ICE candidates
   - Routes messages based on role

3. **Network Status**
   - Tracks available/busy senders
   - Broadcasts network status to all clients
   - Enables receiver auto-connect logic

4. **Message Types**
   - `register` - Register as sender/receiver
   - `offer` - WebRTC offer (forwarded to appropriate peer)
   - `answer` - WebRTC answer (forwarded to appropriate peer)
   - `ice-candidate` - ICE candidate (forwarded to peer)
   - `sender-status` - Update sender status (available/busy)
   - `network-status` - Broadcast network status
   - `check-sender` - Check if sender exists

## Message Flow

### Sender-Initiated Connection (Current - Not Used)
```
Sender → WebSocket: offer
Server → Receiver: offer
Receiver → WebSocket: answer
Server → Sender: answer
```

### Receiver-Initiated Connection (Current)
```
Receiver → WebSocket: offer (role: receiver)
Server → Sender: offer
Sender → WebSocket: answer (role: sender)
Server → Receiver: answer
```

## Integration with PeerJS

### Option 1: Keep WebSocket for Discovery
- Use PeerJS for WebRTC connections
- Use WebSocket for peer discovery (share peer IDs)
- Hybrid approach

### Option 2: Replace with PeerServer
- Use PeerServer's built-in discovery
- Remove WebSocket signaling
- Simpler but less control

### Option 3: Use Both
- PeerServer for WebRTC signaling
- WebSocket for application-level features (file selection, status)

## Current Status Endpoint

Add this to check WebSocket server status:

```javascript
app.get('/api/ws-status', (req, res) => {
  res.json({
    connected: wss.clients.size,
    senders: clients.senders.length,
    receivers: clients.receivers.length,
    senderStatus: Array.from(senderStatus.entries()).map(([ws, status]) => ({
      status: status.status,
      fileName: status.fileName
    }))
  });
});
```

## Testing WebSocket Connection

```javascript
// In browser console
const ws = new WebSocket('ws://localhost:3000');
ws.onopen = () => console.log('Connected');
ws.onmessage = (e) => console.log('Received:', JSON.parse(e.data));
ws.send(JSON.stringify({ type: 'register', role: 'sender' }));
```

## Files

- `server.js` - WebSocket server implementation (lines 137-375)
- `public/app.js` - WebSocket client code

