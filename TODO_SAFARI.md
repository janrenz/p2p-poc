# Safari-Specific Fixes and Optimizations

## Current Issues
- Safari becomes unresponsive during large file transfers
- Safari has stricter memory management than Chrome/Firefox
- Safari may have different WebRTC DataChannel behavior

## Implemented Fixes

### Memory Management
- ✅ Throttled UI updates (max every 200ms) to reduce DOM manipulation overhead
- ✅ Limited pending chunks to 50 max to prevent unbounded memory growth
- ✅ Periodic cleanup of acknowledged chunks (every 100 chunks)
- ✅ Memory cleanup after transfer completes
- ✅ File data loaded from IndexedDB when needed (not kept in memory)
- ✅ Batched ACKs (every 5th chunk) to reduce overhead
- ✅ Non-blocking IndexedDB operations
- ✅ Process chunks in batches with setTimeout(0) to yield to browser

### Chunk Size
- ✅ Reduced to 16KB for Safari compatibility (WebRTC message size limits)
- ⚠️ Increased to 64KB for other browsers (better performance)

## Pending Safari-Specific Optimizations

### High Priority
- [ ] Detect Safari browser and use smaller chunk size (16KB) automatically
- [ ] Add Safari-specific memory pressure monitoring
- [ ] Implement more aggressive garbage collection hints for Safari
- [ ] Add Safari-specific DataChannel buffer size detection
- [ ] Reduce UI update frequency further for Safari (maybe 500ms instead of 200ms)

### Medium Priority
- [ ] Test Safari's IndexedDB performance and optimize if needed
- [ ] Add Safari-specific error handling for memory issues
- [ ] Implement Safari-specific workarounds for WebRTC DataChannel limits
- [ ] Add Safari version detection and version-specific fixes
- [ ] Consider using Web Workers for chunk processing in Safari

### Low Priority
- [ ] Add Safari performance profiling hooks
- [ ] Implement Safari-specific connection retry logic
- [ ] Add Safari memory usage monitoring/display
- [ ] Consider alternative chunking strategies for Safari

## Browser Detection Code Needed

```javascript
// Detect Safari
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
// Or more reliable:
const isSafari = navigator.vendor && navigator.vendor.indexOf('Apple') > -1 &&
                 navigator.userAgent &&
                 navigator.userAgent.indexOf('CriOS') === -1 &&
                 navigator.userAgent.indexOf('FxiOS') === -1;

// Use smaller chunks for Safari
if (isSafari) {
    senderChunkState.chunkSize = 16 * 1024; // 16KB for Safari
} else {
    senderChunkState.chunkSize = 64 * 1024; // 64KB for others
}
```

## Notes
- Safari has stricter memory limits and garbage collection
- Safari may have different WebRTC implementation details
- Consider testing on Safari iOS as well (may have different behavior)
- Current chunk size: 64KB (optimized for Chrome/Firefox), 16KB needed for Safari


