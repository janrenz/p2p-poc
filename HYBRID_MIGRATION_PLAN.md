# Hybrid Migration Plan: RTCMultiConnection + Custom Chunking

## Strategy

We'll use RTCMultiConnection for:
- Signaling server (replaces our custom WebSocket signaling)
- Peer connection management (replaces SimplePeer)
- Multi-peer support (built-in)

We'll keep our custom implementation for:
- Binary chunking protocol with sequence numbers
- ACK/NACK system
- Flow control using bufferedAmount
- Resume functionality with IndexedDB
- File caching

## Migration Steps

### Phase 1: Replace Signaling Server
1. Install RTCMultiConnection server
2. Replace custom WebSocket signaling with RTCMultiConnection signaling
3. Update client to use RTCMultiConnection client library

### Phase 2: Replace Peer Management
1. Replace SimplePeer with RTCMultiConnection's peer management
2. Keep data channel access for our custom protocol
3. Maintain our chunking/flow control logic

### Phase 3: Testing & Optimization
1. Test with multiple peers
2. Verify chunking protocol still works
3. Ensure resume functionality works
4. Test Safari optimizations

## Benefits

- **Simplified signaling**: RTCMultiConnection handles all signaling complexity
- **Better peer management**: Built-in support for multiple peers
- **Maintained codebase**: Less custom code to maintain
- **Keep control**: Still have fine-grained control over chunking/flow control

## Risks

- **Learning curve**: Need to understand RTCMultiConnection API
- **Migration effort**: Significant refactoring required
- **Potential breaking changes**: RTCMultiConnection updates might affect us
- **Bundle size**: RTCMultiConnection is larger than SimplePeer

