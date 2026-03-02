// Receiver JavaScript - Receives file via WebRTC P2P
let peer = null;
let ws = null;
let isConnected = false;
let fileMetadata = null;
let receivedChunks = [];
let totalReceived = 0;

const downloadBtn = document.getElementById('downloadBtn');
const downloadStatus = document.getElementById('downloadStatus');
const downloadProgress = document.getElementById('downloadProgress');
const downloadProgressBar = document.getElementById('downloadProgressBar');

// Connect to WebSocket signaling server
function connectSignaling() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    console.log('Connecting to WebSocket:', wsUrl);
    
    try {
        ws = new WebSocket(wsUrl);
    } catch (error) {
        console.error('Failed to create WebSocket:', error);
        downloadStatus.innerHTML = `<div class="status error">Failed to create WebSocket: ${error.message}</div>`;
        return;
    }

    ws.onopen = () => {
        console.log('Connected to signaling server');
        ws.send(JSON.stringify({ type: 'register', role: 'receiver' }));
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('Received message:', data.type);
            
            if (data.type === 'registered') {
                console.log('Registered as receiver');
                downloadStatus.innerHTML = '<div class="status info">Waiting for sender to connect...</div>';
            } else if (data.type === 'offer') {
                console.log('Received offer from sender');
                handleOffer(data.offer);
            } else if (data.type === 'ice-candidate') {
                console.log('Received ICE candidate');
                if (peer && data.candidate) {
                    peer.signal(data.candidate);
                }
            }
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        console.error('WebSocket readyState:', ws?.readyState);
        downloadStatus.innerHTML = `<div class="status error">Failed to connect to signaling server. Check console for details.</div>`;
    };

    ws.onclose = (event) => {
        console.log('WebSocket connection closed', event.code, event.reason);
        if (event.code !== 1000) {
            downloadStatus.innerHTML = `<div class="status error">WebSocket closed unexpectedly (code: ${event.code})</div>`;
        }
    };
}

function handleOffer(offer) {
    // Create WebRTC peer (receiver)
    peer = new SimplePeer({
        initiator: false,
        trickle: false
    });

    peer.on('signal', (data) => {
        console.log('Sending signal:', data.type);
        if (ws && ws.readyState === WebSocket.OPEN) {
            if (data.type === 'answer') {
                ws.send(JSON.stringify({ type: 'answer', answer: data }));
            } else if (data.candidate) {
                ws.send(JSON.stringify({ type: 'ice-candidate', candidate: data, role: 'receiver' }));
            }
        }
    });

    peer.on('connect', () => {
        console.log('WebRTC connected!');
        isConnected = true;
        downloadStatus.innerHTML = '<div class="status success">✓ Connected to sender! Receiving file...</div>';
        downloadProgress.style.display = 'block';
    });

    peer.on('data', (data) => {
        handleReceivedData(data);
    });

    peer.on('error', (err) => {
        console.error('Peer error:', err);
        downloadStatus.innerHTML = `<div class="status error">Connection error: ${err.message}</div>`;
        downloadBtn.disabled = false;
    });

    peer.on('close', () => {
        console.log('Peer connection closed');
        isConnected = false;
    });

    // Signal with the offer
    peer.signal(offer);
}

function handleReceivedData(data) {
    // SimplePeer sends data as Buffer/Uint8Array
    let buffer;
    if (data instanceof ArrayBuffer) {
        buffer = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
        buffer = data;
    } else if (Buffer.isBuffer(data)) {
        buffer = new Uint8Array(data);
    } else {
        buffer = new Uint8Array(data);
    }

    // Check if we're expecting metadata (first message should be JSON)
    if (!fileMetadata) {
        // Try to parse as JSON metadata
        try {
            const text = new TextDecoder().decode(buffer);
            const metadata = JSON.parse(text);
            
            if (metadata.type === 'file-metadata') {
                fileMetadata = metadata;
                receivedChunks = [];
                totalReceived = 0;
                downloadStatus.innerHTML = `<div class="status info">Receiving file: ${metadata.name} (${(metadata.size / 1024 / 1024).toFixed(2)} MB)</div>`;
                return;
            }
        } catch (e) {
            // Not JSON, might be binary data - but we need metadata first
            console.warn('Expected metadata but got binary data');
            return;
        }
    } else {
        // File chunk
        receivedChunks.push(buffer);
        totalReceived += buffer.length;
        
        const progress = (totalReceived / fileMetadata.size) * 100;
        downloadProgressBar.style.width = progress + '%';
        
        downloadStatus.innerHTML = `
            <div class="status info">
                Downloading: ${(totalReceived / 1024 / 1024).toFixed(2)} MB / ${(fileMetadata.size / 1024 / 1024).toFixed(2)} MB (${progress.toFixed(1)}%)
            </div>
        `;

        // Check if file is complete
        if (totalReceived >= fileMetadata.size) {
            completeDownload();
        }
    }
}

function completeDownload() {
    if (!fileMetadata) return;

    downloadStatus.innerHTML = '<div class="status success">✓ Download complete!</div>';
    
    // Combine all chunks into a single blob
    // Convert Uint8Array chunks to a single ArrayBuffer
    const totalLength = receivedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of receivedChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }
    
    const blob = new Blob([combined], { type: fileMetadata.mimeType || 'application/octet-stream' });
    
    // Create download link
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileMetadata.name;
    a.style.display = 'block';
    a.style.marginTop = '10px';
    a.style.padding = '12px 24px';
    a.style.background = 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)';
    a.style.color = 'white';
    a.style.textDecoration = 'none';
    a.style.borderRadius = '8px';
    a.style.textAlign = 'center';
    a.textContent = `Download ${fileMetadata.name}`;
    
    downloadStatus.appendChild(a);
    
    // Auto-click after a moment
    setTimeout(() => {
        a.click();
        URL.revokeObjectURL(url);
    }, 500);
}

downloadBtn.addEventListener('click', () => {
    if (isConnected) {
        downloadStatus.innerHTML = '<div class="status info">Already connected. Waiting for file...</div>';
        return;
    }

    try {
        downloadBtn.disabled = true;
        downloadStatus.innerHTML = '<div class="status info">Connecting to sender...</div>';

        // Connect to signaling server
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectSignaling();
        }
    } catch (error) {
        console.error('Connection error:', error);
        downloadStatus.innerHTML = `<div class="status error">Error: ${error.message}</div>`;
        downloadBtn.disabled = false;
    }
});

// Auto-connect when page loads
window.addEventListener('load', () => {
    connectSignaling();
});
