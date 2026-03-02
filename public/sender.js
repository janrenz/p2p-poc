// Sender JavaScript - Downloads file and shares via WebRTC P2P
let downloadedFile = null;
let peer = null;
let dataChannel = null;
let ws = null;
let isConnected = false;

const downloadBtn = document.getElementById('downloadBtn');
const shareBtn = document.getElementById('shareBtn');
const downloadStatus = document.getElementById('downloadStatus');
const shareStatus = document.getElementById('shareStatus');
const downloadProgress = document.getElementById('downloadProgress');
const downloadProgressBar = document.getElementById('downloadProgressBar');
const connectionInfo = document.getElementById('connectionInfo');

// Connect to WebSocket signaling server
function connectSignaling() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    console.log('Connecting to WebSocket:', wsUrl);
    
    try {
        ws = new WebSocket(wsUrl);
    } catch (error) {
        console.error('Failed to create WebSocket:', error);
        shareStatus.innerHTML = `<div class="status error">Failed to create WebSocket: ${error.message}</div>`;
        return;
    }

    ws.onopen = () => {
        console.log('Connected to signaling server');
        ws.send(JSON.stringify({ type: 'register', role: 'sender' }));
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('Received message:', data.type);
            
            if (data.type === 'registered') {
                console.log('Registered as sender');
            } else if (data.type === 'answer') {
                console.log('Received answer from receiver');
                if (peer) {
                    peer.signal(data.answer);
                }
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
        shareStatus.innerHTML = `<div class="status error">Failed to connect to signaling server. Check console for details.</div>`;
    };

    ws.onclose = (event) => {
        console.log('WebSocket connection closed', event.code, event.reason);
        if (event.code !== 1000) {
            shareStatus.innerHTML = `<div class="status error">WebSocket closed unexpectedly (code: ${event.code})</div>`;
        }
    };
}

downloadBtn.addEventListener('click', async () => {
    try {
        downloadBtn.disabled = true;
        downloadStatus.innerHTML = '<div class="status info">Downloading test file...</div>';
        downloadProgress.style.display = 'block';
        downloadProgressBar.style.width = '0%';

        // Download a test file from a reliable source
        // Tested and verified working URLs - Linux ISOs tried first
        const testFileUrls = [
            // Large Linux ISO files (1-6GB) - tried first
            { url: 'https://old-releases.ubuntu.com/releases/24.04.1/ubuntu-24.04.1-desktop-amd64.iso', name: 'Ubuntu 24.04.1 Desktop ISO (~6GB)' },
            { url: 'https://old-releases.ubuntu.com/releases/24.04.1/ubuntu-24.04.1-live-server-amd64.iso', name: 'Ubuntu 24.04.1 Server ISO (~2.7GB)' },
            { url: 'https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-13.1.0-amd64-netinst.iso', name: 'Debian 13.1.0 Netinst ISO (~400MB)' },
            // Medium test files (50-100MB) - fallback
            { url: 'https://leil.de/di/files/more/testdaten/50mb.test', name: 'leil.de 50MB' },
            { url: 'https://proof.ovh.net/files/100Mb.dat', name: 'OVH 100MB' },
            { url: 'https://www.learningcontainer.com/wp-content/uploads/2019/09/sample-pdf-file.pdf', name: 'Learning Container PDF (~140KB)' }
        ];
        
        let response = null;
        let lastError = null;
        let usedSource = null;
        
        // Try each URL until one works
        for (const source of testFileUrls) {
            try {
                downloadStatus.innerHTML = `<div class="status info">Trying ${source.name}...</div>`;
                console.log(`Attempting to fetch: ${source.url}`);
                
                // Add timeout and better error handling
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
                
                try {
                    // Try direct fetch first, fallback to proxy if CORS fails
                    let fetchUrl = source.url;
                    let useProxy = false;
                    let directFetchFailed = false;
                    
                    try {
                        response = await fetch(source.url, {
                            signal: controller.signal,
                            method: 'GET',
                            mode: 'cors',
                            cache: 'no-cache'
                        });
                        
                        // Check if response is ok
                        if (!response.ok) {
                            directFetchFailed = true;
                        }
                    } catch (corsError) {
                        // CORS or network error - use proxy
                        console.log(`${source.name} direct fetch failed (likely CORS), trying proxy...`);
                        directFetchFailed = true;
                    }
                    
                    // If direct fetch failed, try proxy
                    if (directFetchFailed) {
                        useProxy = true;
                        fetchUrl = `/api/fetch-file?url=${encodeURIComponent(source.url)}`;
                        response = await fetch(fetchUrl, {
                            signal: controller.signal,
                            method: 'GET',
                            cache: 'no-cache'
                        });
                    }
                    
                    clearTimeout(timeoutId);
                    
                    if (response.ok) {
                        usedSource = useProxy ? `${source.name} (via proxy)` : source.name;
                        console.log(`Successfully connected to ${source.name}${useProxy ? ' via proxy' : ''}`);
                        break;
                    } else {
                        console.warn(`${source.name} returned status: ${response.status} ${response.statusText}`);
                        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }
                } catch (fetchError) {
                    clearTimeout(timeoutId);
                    if (fetchError.name === 'AbortError') {
                        console.warn(`${source.name} timed out after 30 seconds`);
                        lastError = new Error('Request timed out');
                    } else {
                        console.warn(`${source.name} failed:`, fetchError);
                        lastError = fetchError;
                    }
                }
            } catch (error) {
                console.warn(`Error with ${source.name}:`, error);
                lastError = error;
                continue;
            }
        }
        
        if (!response || !response.ok) {
            const errorMsg = lastError?.message || 'All sources failed';
            const errorDetails = lastError?.stack ? `\nDetails: ${lastError.stack}` : '';
            throw new Error(`Failed to download test file: ${errorMsg}${errorDetails}\n\nTried ${testFileUrls.length} sources. This might be a CORS or network issue.`);
        }

        downloadStatus.innerHTML = `<div class="status info">Downloading from ${usedSource}...</div>`;
        const contentLength = parseInt(response.headers.get('content-length') || '52428800');
        const reader = response.body.getReader();
        const chunks = [];
        let receivedLength = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            chunks.push(value);
            receivedLength += value.length;
            const progress = (receivedLength / contentLength) * 100;
            downloadProgressBar.style.width = progress + '%';
        }

        // Create blob from chunks
        // Determine file type from response headers or URL
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const contentDisposition = response.headers.get('content-disposition') || '';
        let fileName = 'test-file-50mb';
        
        // Try to extract filename from Content-Disposition header
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (filenameMatch) {
            fileName = filenameMatch[1].replace(/['"]/g, '');
        } else if (response.url.includes('.pdf')) {
            fileName = 'test-file-50mb.pdf';
        } else {
            fileName = 'test-file-50mb.bin';
        }
        
        const blob = new Blob(chunks, { type: contentType });
        downloadedFile = new File([blob], fileName, { type: contentType });

        downloadStatus.innerHTML = `<div class="status success">✓ File downloaded successfully! (${(downloadedFile.size / 1024 / 1024).toFixed(2)} MB)</div>`;
        downloadProgress.style.display = 'none';
        shareBtn.disabled = false;
        
    } catch (error) {
        console.error('Download error:', error);
        downloadStatus.innerHTML = `<div class="status error">Error: ${error.message}</div>`;
        downloadBtn.disabled = false;
    }
});

shareBtn.addEventListener('click', () => {
    if (!downloadedFile) {
        shareStatus.innerHTML = '<div class="status error">Please download the file first!</div>';
        return;
    }

    try {
        shareBtn.disabled = true;
        shareStatus.innerHTML = '<div class="status info">Initializing WebRTC connection...</div>';

        // Connect to signaling server first
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectSignaling();
            // Wait for WebSocket to be ready
            const checkConnection = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    clearInterval(checkConnection);
                    createPeer();
                }
            }, 100);
        } else {
            createPeer();
        }
    } catch (error) {
        console.error('Share error:', error);
        shareStatus.innerHTML = `<div class="status error">Error: ${error.message}</div>`;
        shareBtn.disabled = false;
    }
});

function createPeer() {
    // Create WebRTC peer (initiator)
    peer = new SimplePeer({
        initiator: true,
        trickle: false
    });

        peer.on('signal', (data) => {
            console.log('Sending signal:', data.type);
            if (ws && ws.readyState === WebSocket.OPEN) {
                if (data.type === 'offer') {
                    ws.send(JSON.stringify({ type: 'offer', offer: data }));
                } else if (data.candidate) {
                    ws.send(JSON.stringify({ type: 'ice-candidate', candidate: data, role: 'sender' }));
                }
            }
        });

        peer.on('connect', () => {
            console.log('WebRTC connected!');
            isConnected = true;
            shareStatus.innerHTML = '<div class="status success">✓ Connected to receiver! Sending file...</div>';
            
            // Send file via data channel
            sendFile();
        });

        peer.on('error', (err) => {
            console.error('Peer error:', err);
            shareStatus.innerHTML = `<div class="status error">Connection error: ${err.message}</div>`;
            shareBtn.disabled = false;
        });

    peer.on('close', () => {
        console.log('Peer connection closed');
        isConnected = false;
    });
}

function sendFile() {
    if (!downloadedFile || !isConnected) return;

    const CHUNK_SIZE = 16 * 1024; // 16KB chunks
    const fileReader = new FileReader();
    let offset = 0;
    let totalSent = 0;

    // Send file metadata first
    const metadata = {
        type: 'file-metadata',
        name: downloadedFile.name,
        size: downloadedFile.size,
        mimeType: downloadedFile.type
    };
    
    peer.send(JSON.stringify(metadata));

    fileReader.onload = (e) => {
        const chunk = e.target.result; // ArrayBuffer
        
        // Send chunk as Uint8Array (SimplePeer handles this well)
        peer.send(new Uint8Array(chunk));
        totalSent += chunk.byteLength;
        
        const progress = (totalSent / downloadedFile.size) * 100;
        shareStatus.innerHTML = `
            <div class="status info">
                Sending file: ${(totalSent / 1024 / 1024).toFixed(2)} MB / ${(downloadedFile.size / 1024 / 1024).toFixed(2)} MB (${progress.toFixed(1)}%)
            </div>
        `;

        offset += CHUNK_SIZE;
        
        if (offset < downloadedFile.size) {
            readNextChunk();
        } else {
            // File sent completely
            shareStatus.innerHTML = '<div class="status success">✓ File sent successfully!</div>';
            shareBtn.disabled = false;
        }
    };

    function readNextChunk() {
        const slice = downloadedFile.slice(offset, offset + CHUNK_SIZE);
        fileReader.readAsArrayBuffer(slice);
    }

    readNextChunk();
}
