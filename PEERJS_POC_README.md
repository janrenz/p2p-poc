# PeerJS Proof-of-Concept

This is a proof-of-concept implementation using PeerJS instead of SimplePeer.

## What's Included

1. **PeerServer Integration**: Added PeerServer to the existing Express server
2. **POC Implementation**: `app-peerjs.js` - Simplified version using PeerJS
3. **POC HTML**: `app-peerjs.html` - Test page for PeerJS implementation
4. **Standalone PeerServer**: `peerjs-server.js` - Can run separately if needed

## How to Test

1. **Start the server**:
   ```bash
   npm start
   ```

2. **Open two browser windows**:
   - Window 1: `http://localhost:3000/peerjs-poc`
     - Click "Connect as Sender"
     - Copy the Peer ID shown
   
   - Window 2: `http://localhost:3000/peerjs-poc`
     - Click "Connect as Receiver"
     - Paste the sender's Peer ID
     - Click "Connect to Sender"

3. **Test the connection**:
   - The receiver should connect to the sender
   - You can test sending data between them

## Key Differences from SimplePeer

### Simpler API
```javascript
// SimplePeer (current)
peer = new SimplePeer({ initiator: true });
peer.on('signal', (data) => { /* manual signaling */ });
peer.signal(offer);

// PeerJS (POC)
peer = new Peer('sender-id', { host: 'localhost', port: 9000 });
peer.on('connection', (conn) => { /* ready */ });
```

### Built-in Signaling
- No custom WebSocket signaling needed
- PeerServer handles peer discovery
- Automatic offer/answer exchange

### Benefits
- ✅ No "wrong state" errors
- ✅ Simpler connection management
- ✅ Better error messages
- ✅ Automatic peer ID management

## Current Limitations (POC)

1. **Peer Discovery**: Currently requires manual peer ID entry
   - In production, would use a discovery mechanism
   - Could integrate with existing WebSocket for peer discovery

2. **File Transfer**: Not fully implemented yet
   - Chunking protocol structure is there
   - Needs integration with file download/sharing logic

3. **Flow Control**: Needs testing
   - PeerJS data channels may behave differently
   - Need to verify bufferedAmount access

## Next Steps

1. **Test with Real File Transfer**
   - Integrate chunking protocol
   - Test flow control
   - Compare performance vs SimplePeer

2. **Peer Discovery**
   - Use WebSocket for peer ID exchange
   - Or use PeerServer's discovery features

3. **Full Migration**
   - Replace SimplePeer in main app
   - Keep custom chunking protocol
   - Update signaling to use PeerServer

## Files

- `public/app-peerjs.js` - POC implementation
- `public/app-peerjs.html` - Test page
- `peerjs-server.js` - Standalone PeerServer (optional)
- `server.js` - Updated with PeerServer integration

## References

- [PeerJS Documentation](https://peerjs.com/)
- [PeerJS Examples](https://peerjs.com/examples)
- [PeerServer GitHub](https://github.com/peers/peerjs-server)

