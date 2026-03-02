# PeerJS Evaluation for P2P File Sharing

## Current State
- Using **SimplePeer** with custom WebSocket signaling server
- Custom chunking protocol with ACK/NACK
- Flow control for large files
- IndexedDB caching
- Multiple receivers support
- Complex state management issues

## PeerJS Overview

[PeerJS](https://peerjs.com/) is a wrapper around WebRTC that simplifies peer-to-peer connections.

### Key Features
- **Simpler API**: Abstracts WebRTC complexity
- **Built-in Signaling**: PeerServer (cloud or self-hosted)
- **Data Channels**: Support for peer-to-peer data transfer
- **Automatic Peer IDs**: No manual ID management
- **Better Error Handling**: More user-friendly errors

### Advantages Over SimplePeer

1. **Simpler Connection Management**
   ```javascript
   // SimplePeer (current)
   peer = new SimplePeer({ initiator: true });
   peer.on('signal', (data) => { /* manual signaling */ });
   peer.signal(offer);
   
   // PeerJS (proposed)
   const peer = new Peer();
   const conn = peer.connect('receiver-id');
   conn.on('open', () => { /* ready */ });
   ```

2. **Built-in Signaling Server**
   - Can use PeerJS cloud (free tier available)
   - Or self-host PeerServer
   - No need for custom WebSocket signaling

3. **Automatic State Management**
   - No manual offer/answer handling
   - No "wrong state" errors
   - Simpler connection lifecycle

4. **Better Error Messages**
   - More descriptive errors
   - Better debugging support

### Potential Challenges

1. **Custom Chunking Protocol**
   - ✅ Can keep our custom chunking logic
   - ✅ Data channels support binary data
   - ✅ Flow control can still be implemented

2. **Signaling Server**
   - Option A: Use PeerJS cloud (free tier: 50 concurrent connections)
   - Option B: Self-host PeerServer (open source)
   - Option C: Keep custom WebSocket but use PeerJS for peer management

3. **Migration Effort**
   - Need to refactor connection logic
   - Keep chunking/flow control code
   - Update signaling to use PeerJS API

## Migration Strategy

### Option 1: Full Migration to PeerJS
- Replace SimplePeer with PeerJS
- Use PeerServer (cloud or self-hosted)
- Keep custom chunking protocol
- **Pros**: Simpler code, fewer state errors
- **Cons**: Dependency on PeerJS, need to migrate signaling

### Option 2: Hybrid Approach
- Use PeerJS for peer management
- Keep custom WebSocket signaling (if needed)
- Keep custom chunking protocol
- **Pros**: More control, gradual migration
- **Cons**: Still some complexity

### Option 3: Keep SimplePeer, Fix Issues
- Fix current state management issues
- Improve error handling
- Keep existing architecture
- **Pros**: No migration needed
- **Cons**: More complex code to maintain

## Recommendation

**Option 1 (Full Migration)** seems best because:
1. Simpler API will reduce bugs
2. Built-in signaling eliminates custom server complexity
3. Better error handling
4. Can still use custom chunking protocol
5. Actively maintained library

## Next Steps

1. Install PeerJS: `npm install peerjs`
2. Create proof-of-concept with PeerJS
3. Test with our chunking protocol
4. Compare performance vs SimplePeer
5. Decide on signaling (cloud vs self-hosted)

## Code Example (PeerJS)

```javascript
// Sender
const peer = new Peer('sender-id', {
  host: 'localhost',
  port: 9000,
  path: '/peerjs'
});

peer.on('open', (id) => {
  console.log('My peer ID is: ' + id);
});

peer.on('connection', (conn) => {
  conn.on('open', () => {
    // Send file chunks
    sendChunkWithFlowControl(chunkData, conn);
  });
  
  conn.on('data', (data) => {
    // Handle ACKs
    handleChunkAck(data);
  });
});

// Receiver
const peer = new Peer('receiver-id', {
  host: 'localhost',
  port: 9000,
  path: '/peerjs'
});

peer.on('open', (id) => {
  const conn = peer.connect('sender-id');
  conn.on('open', () => {
    // Ready to receive
  });
  
  conn.on('data', (data) => {
    // Handle chunks
    handleReceivedChunk(data);
  });
});
```

## References
- [PeerJS Documentation](https://peerjs.com/)
- [PeerJS Examples](https://peerjs.com/examples)
- [PeerServer GitHub](https://github.com/peers/peerjs-server)

