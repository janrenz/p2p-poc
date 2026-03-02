# Hybrid Implementation: RTCMultiConnection + Custom Chunking

## Decision

After reviewing RTCMultiConnection, we're implementing a **practical hybrid approach**:

1. **Keep our custom signaling server** - It's working well and tailored to our needs
2. **Add RTCMultiConnection client library** - For better peer management and multi-peer support
3. **Keep our custom chunking protocol** - Fine-grained control over chunking, flow control, resume

## Implementation Strategy

### Phase 1: Add RTCMultiConnection Client (Current)
- Include RTCMultiConnection client library via CDN
- Keep SimplePeer as fallback during migration
- Gradually migrate peer creation to RTCMultiConnection

### Phase 2: Migrate Peer Management
- Replace SimplePeer peer creation with RTCMultiConnection
- Use RTCMultiConnection's data channels
- Keep our custom chunking protocol on top

### Phase 3: Leverage Multi-Peer Features
- Use RTCMultiConnection's built-in multi-peer support
- Simplify our mesh network code
- Keep custom chunking/flow control

## Benefits

✅ **Better peer management** - RTCMultiConnection handles connection lifecycle better
✅ **Multi-peer support** - Built-in support for multiple simultaneous connections
✅ **Keep our optimizations** - Safari optimizations, custom chunking, resume still work
✅ **Maintained library** - Less code to maintain ourselves
✅ **Gradual migration** - Can migrate piece by piece

## Migration Notes

- RTCMultiConnection uses `connection` object instead of `peer`
- Data channels accessed via `connection.channels`
- Signaling can work with our custom server or RTCMultiConnection's server
- We'll use our custom signaling server to maintain control

