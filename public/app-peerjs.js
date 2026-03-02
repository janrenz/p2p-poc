// PeerJS Proof-of-Concept - Simplified P2P File Sharing
// This demonstrates how PeerJS could replace SimplePeer

const isSafari = navigator.vendor && navigator.vendor.indexOf('Apple') > -1 &&
                 navigator.userAgent &&
                 navigator.userAgent.indexOf('CriOS') === -1 &&
                 navigator.userAgent.indexOf('FxiOS') === -1;

let currentRole = null; // 'sender' or 'receiver'
let peer = null;
let dataConn = null;
let isConnected = false;
let fileMetadata = null;
let transferActive = false;

// Chunking protocol state (same as before)
let senderChunkState = {
    chunkSize: isSafari ? 16 * 1024 : 64 * 1024,
    nextChunkIndex: 0,
    pendingChunks: new Map(),
    acknowledgedChunks: new Set(),
    maxBufferSize: 256 * 1024,
    maxPendingChunks: isSafari ? 30 : 50,
};

let receiverChunkState = {
    receivedChunkMap: new Map(),
    expectedChunkIndex: 0,
};

// Initialize PeerJS
function initPeerJS(role) {
    currentRole = role;
    
    // Generate unique peer ID based on role
    const peerId = role + '-' + Math.random().toString(36).substr(2, 9);
    
    console.log(`Initializing PeerJS as ${role} with ID: ${peerId}`);
    
    // Create Peer instance
    // Use same port as main server (PeerServer is integrated)
    const port = window.location.port || '3000';
    peer = new Peer(peerId, {
        host: window.location.hostname,
        port: port,
        path: '/peerjs',
        debug: 3
    });
    
    peer.on('open', (id) => {
        console.log(`PeerJS connected with ID: ${id}`);
        updateStatus('success', `Connected as ${role} (ID: ${id})`);
        
        if (role === 'sender') {
            // Sender waits for receiver connections
            setupSenderListeners();
        } else {
            // Receiver connects to sender
            setupReceiverListeners();
        }
    });
    
    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        updateStatus('error', `PeerJS error: ${err.message}`);
    });
    
    peer.on('disconnected', () => {
        console.log('PeerJS disconnected');
        isConnected = false;
        dataConn = null;
    });
    
    peer.on('close', () => {
        console.log('PeerJS closed');
        isConnected = false;
        dataConn = null;
    });
}

// Setup sender: listen for incoming connections
function setupSenderListeners() {
    peer.on('connection', (conn) => {
        console.log('Receiver connected:', conn.peer);
        
        dataConn = conn;
        window.dataConn = conn; // Make available globally
        
        conn.on('open', () => {
            console.log('Data connection opened');
            isConnected = true;
            window.isConnected = true;
            transferActive = true;
            window.transferActive = true;
            updateStatus('success', 'Receiver connected! Ready to share.');
            
            // Update UI
            if (typeof window !== 'undefined' && window.senderStatus) {
                window.senderStatus.innerHTML = '<div class="status success">✓ Receiver connected! Ready to share.</div>';
            }
            
            // Auto-share if we have a cached file
            if (window.cachedFileMetadata) {
                shareCachedFile(window.cachedFileMetadata.name);
            }
        });
        
        conn.on('data', (data) => {
            handleReceivedData(data);
        });
        
        conn.on('close', () => {
            console.log('Data connection closed');
            isConnected = false;
            window.isConnected = false;
            dataConn = null;
            window.dataConn = null;
        });
        
        conn.on('error', (err) => {
            console.error('Data connection error:', err);
        });
    });
}

// Setup receiver: connect to sender
// Note: This function is called but connection is initiated from UI
function setupReceiverListeners() {
    console.log('Receiver setup complete - use connectToSender() to connect');
    // Connection will be initiated from UI when user enters sender ID
}

// Handle received data (same chunking protocol)
function handleReceivedData(data) {
    if (currentRole === 'receiver') {
        handleReceivedChunk(data);
    } else {
        handleChunkAck(data);
    }
}

// Send chunk with flow control (same as before, but using PeerJS connection)
async function sendChunkWithFlowControl(chunkData, chunkIndex) {
    const conn = dataConn || window.dataConn;
    const connected = isConnected || window.isConnected;
    
    if (!conn || !connected) {
        console.warn('Connection not ready, storing chunk for retry');
        senderChunkState.pendingChunks.set(chunkIndex, chunkData);
        return;
    }
    
    // Check buffer size (PeerJS doesn't expose bufferedAmount directly)
    // We'll use our own flow control
    
    // Encode chunk: [4-byte index][chunk data]
    const header = new ArrayBuffer(4);
    const headerView = new DataView(header);
    headerView.setUint32(0, chunkIndex, true);
    
    const message = new Uint8Array(4 + chunkData.length);
    message.set(new Uint8Array(header), 0);
    message.set(chunkData, 4);
    
    try {
        // PeerJS supports sending ArrayBuffer directly
        conn.send(message.buffer);
        senderChunkState.pendingChunks.set(chunkIndex, chunkData);
    } catch (e) {
        console.error('Failed to send chunk:', e);
        senderChunkState.pendingChunks.set(chunkIndex, chunkData);
    }
}

// Handle chunk ACK (same as before)
function handleChunkAck(data) {
    try {
        const text = new TextDecoder().decode(data);
        const message = JSON.parse(text);
        
        if (message.type === 'chunk-ack') {
            const chunkIndex = message.chunkIndex;
            senderChunkState.acknowledgedChunks.add(chunkIndex);
            senderChunkState.pendingChunks.delete(chunkIndex);
        }
    } catch (e) {
        // Not JSON, ignore
    }
}

// Handle received chunk (same as before)
function handleReceivedChunk(data) {
    if (data instanceof ArrayBuffer) {
        data = new Uint8Array(data);
    } else if (typeof data === 'string') {
        // Might be JSON metadata
        try {
            const message = JSON.parse(data);
            if (message.type === 'file-metadata') {
                fileMetadata = message;
                console.log('Received file metadata:', message);
                return;
            }
        } catch (e) {
            // Not JSON, continue processing as binary
        }
    }
    
    if (!(data instanceof Uint8Array) || data.length < 4) return;
    
    // Extract chunk index from header
    const chunkIndex = new DataView(data.buffer).getUint32(0, true);
    const chunkData = data.slice(4);
    
    // Store chunk
    receiverChunkState.receivedChunkMap.set(chunkIndex, chunkData);
    
    // Send ACK
    const conn = dataConn || window.dataConn;
    const connected = isConnected || window.isConnected;
    if (conn && connected) {
        try {
            conn.send(JSON.stringify({
                type: 'chunk-ack',
                chunkIndex: chunkIndex
            }));
        } catch (e) {
            console.error('Failed to send ACK:', e);
        }
    }
}

// Share cached file (simplified version)
async function shareCachedFile(fileName) {
    const conn = dataConn || window.dataConn;
    const connected = isConnected || window.isConnected;
    
    if (!conn || !connected) {
        console.warn('Not connected, cannot share file');
        return;
    }
    
    // Send metadata
    const metadata = {
        type: 'file-metadata',
        name: fileName,
        size: window.cachedFileMetadata ? window.cachedFileMetadata.size : 0,
        mimeType: window.cachedFileMetadata ? window.cachedFileMetadata.mimeType : 'application/octet-stream'
    };
    
    try {
        conn.send(JSON.stringify(metadata));
        console.log('File metadata sent:', metadata);
        
        // Load file from IndexedDB and send chunks
        // (Implementation would be similar to current code)
        console.log('File sharing started');
    } catch (e) {
        console.error('Failed to send metadata:', e);
    }
}

// Update status UI
function updateStatus(type, message) {
    console.log(`[${type}] ${message}`);
    // Update UI elements here
}

// Export for use in main app
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initPeerJS,
        sendChunkWithFlowControl,
        handleReceivedData
    };
}

