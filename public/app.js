// Unified P2P File Sharing App - Auto-detects role
// Detect Safari browser for Safari-specific optimizations
const isSafari = navigator.vendor && navigator.vendor.indexOf('Apple') > -1 &&
                 navigator.userAgent &&
                 navigator.userAgent.indexOf('CriOS') === -1 &&
                 navigator.userAgent.indexOf('FxiOS') === -1;

let currentRole = null; // 'sender' or 'receiver'
let downloadedFile = null;
let peer = null;
let ws = null;
let isConnected = false;
let fileMetadata = null;
let receivedChunks = [];
let totalReceived = 0;
let metadataSent = false; // Track if metadata was sent
let sharingStarted = false; // Track if sharing started
let currentReader = null; // Track current download reader for cancellation
let transferActive = false; // Track if transfer is active
let senderSelectedFiles = new Set(); // Files selected for multi-file sender
let senderStopRequested = false; // Flag set by stopSender() to break multi-file loop
let db = null; // IndexedDB database instance
let currentFileStore = null; // Current file store name in IndexedDB

// Chunking protocol state (sender)
let senderChunkState = {
    chunkSize: isSafari ? 16 * 1024 : 256 * 1024, // 16KB for Safari, 256KB for others
    nextChunkIndex: 0,
    pendingChunks: new Map(), // Map<chunkIndex, chunkData> for retry
    acknowledgedChunks: new Set(), // Set of acknowledged chunk indices
    windowSize: 10, // Sliding window size
    maxBufferSize: 8 * 1024 * 1024, // 8MB buffer — plenty of headroom for local loopback
    maxPendingChunks: isSafari ? 30 : 50, // Lower limit for Safari
    dataChannel: null,
    lastCleanupTime: 0
};

// Chunking protocol state (receiver)
let receiverChunkState = {
    receivedChunkMap: new Map(), // Map<chunkIndex, chunkData>
    expectedChunkIndex: 0,
    lastAckTime: 0,
    ackBatchSize: 10 // Send ACK every N chunks
};

// UI Elements
const roleBadge = document.getElementById('roleBadge');
const senderUI = document.getElementById('senderUI');
const receiverUI = document.getElementById('receiverUI');
const downloadBtn = document.getElementById('downloadBtn');
const shareBtn = document.getElementById('shareBtn');
const switchRoleBtn = document.getElementById('switchRoleBtn');
const downloadStatus = document.getElementById('downloadStatus');
const shareStatus = document.getElementById('shareStatus');
const receiverStatus = document.getElementById('receiverStatus');
const downloadProgress = document.getElementById('downloadProgress');
const downloadProgressBar = document.getElementById('downloadProgressBar');
const receiverProgress = document.getElementById('receiverProgress');
const receiverProgressBar = document.getElementById('receiverProgressBar');
const stopSenderBtn = document.getElementById('stopSenderBtn');
const stopReceiverBtn = document.getElementById('stopReceiverBtn');
const networkStatus = document.getElementById('networkStatus');
const availableSendersEl = document.getElementById('availableSenders');
const busySendersEl = document.getElementById('busySenders');
const totalReceiversEl = document.getElementById('totalReceivers');
const senderListEl = document.getElementById('senderList');
const fileSelection = document.getElementById('fileSelection');
const fileSelectionStatus = document.getElementById('fileSelectionStatus');

// Track selected files for download
let selectedFiles = new Set();

// File name mapping for display
const fileNames = {
    '/test-file-200mb.bin': 'Local Test File (200MB)',
    'https://ash-speed.hetzner.com/100MB.bin': 'Hetzner Test File (100MB)',
    'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_30MB.mp4': 'Big Buck Bunny (30MB MP4)',
    'https://test-videos.co.uk/vids/jellyfish/mp4/h264/1080/Jellyfish_1080_10s_20MB.mp4': 'Jellyfish (20MB MP4)'
};

// Show a video player with the given src URL and title
function showVideoPlayer(src, title) {
    const section = document.getElementById('videoPlayerSection');
    const video = document.getElementById('videoPlayer');
    const titleEl = document.getElementById('videoPlayerTitle');
    if (!section || !video) return;
    video.src = src;
    if (titleEl) titleEl.textContent = title || '';
    section.classList.remove('hidden');
    video.load();
}

function isVideoUrl(url) {
    return /\.(mp4|webm|ogg|mov|avi|mkv)(\?|$)/i.test(url);
}

// ── Per-file state tracking ────────────────────────────────────────────────
// state: 'idle' | 'monitoring' | 'downloading' | 'sharing' | 'receiving' | 'complete' | 'error'
const fileStates = {};
let currentReceivingUrl = null; // URL of the file currently being received

function setFileState(url, state, progress = null) {
    if (!url) return;
    fileStates[url] = { state, progress };
    renderFileStatusPanel();
}

function renderFileStatusPanel() {
    const panel = document.getElementById('fileStatusPanel');
    const list  = document.getElementById('fileStatusList');
    if (!panel || !list) return;

    panel.classList.remove('hidden');

    const stateConfig = {
        idle:        { icon: '○',  label: 'Idle',       cls: 'idle'      },
        monitoring:  { icon: '👁',  label: 'Monitoring', cls: 'monitoring'},
        downloading: { icon: '⬇️', label: 'Downloading',cls: 'active'    },
        sharing:     { icon: '📤', label: 'Sharing',    cls: 'active'    },
        receiving:   { icon: '📥', label: 'Receiving',  cls: 'active'    },
        complete:    { icon: '✅', label: 'Complete',   cls: 'complete'  },
        error:       { icon: '❌', label: 'Error',      cls: 'error'     },
    };

    list.innerHTML = Object.entries(fileNames).map(([url, name]) => {
        const info     = fileStates[url] || {};
        let state      = info.state || 'idle';
        const progress = info.progress;

        // Receivers show 'monitoring' for checked files that aren't active yet
        if (state === 'idle' && currentRole === 'receiver' && selectedFiles.has(url)) {
            state = 'monitoring';
        }

        const cfg = stateConfig[state] || stateConfig.idle;
        const progressBar = (progress !== null && ['downloading','sharing','receiving'].includes(state))
            ? `<div class="file-status-bar"><div class="file-status-bar-inner" style="width:${Math.min(progress,100).toFixed(1)}%"></div></div>`
            : '';
        const labelText = (progress !== null && ['downloading','sharing','receiving'].includes(state))
            ? `${cfg.label} ${progress.toFixed(1)}%`
            : cfg.label;

        return `<div class="file-status-row ${cfg.cls}">
            <span class="file-status-icon">${cfg.icon}</span>
            <div class="file-status-info">
                <div class="file-status-name">${name}</div>
                <div class="file-status-label">${labelText}</div>
                ${progressBar}
            </div>
        </div>`;
    }).join('');
}
// ──────────────────────────────────────────────────────────────────────────

// Initialize file selection checkboxes
function initFileSelection() {
    if (!fileSelection) return;
    
    // Get all checkboxes
    const checkboxes = fileSelection.querySelectorAll('input[type="checkbox"]');
    
    // Load saved selections from localStorage
    const savedSelections = localStorage.getItem('p2p_selected_files');
    if (savedSelections) {
        try {
            const saved = JSON.parse(savedSelections);
            saved.forEach(fileUrl => {
                selectedFiles.add(fileUrl);
                const checkbox = document.querySelector(`input[value="${fileUrl}"]`);
                if (checkbox) {
                    checkbox.checked = true;
                }
            });
        } catch (e) {
            console.warn('Failed to load saved file selections:', e);
        }
    }
    
    // Add event listeners
    checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const fileUrl = e.target.value;
            if (e.target.checked) {
                selectedFiles.add(fileUrl);
            } else {
                selectedFiles.delete(fileUrl);
            }
            
            // Save to localStorage
            localStorage.setItem('p2p_selected_files', JSON.stringify(Array.from(selectedFiles)));
            
            // Update status
            updateFileSelectionStatus();
            renderFileStatusPanel();

            // Check if we should connect/disconnect
            checkForAvailableFiles();
        });
    });
    
    // Initial status update
    updateFileSelectionStatus();
}

// Update file selection status display
function updateFileSelectionStatus() {
    if (!fileSelectionStatus) return;
    
    if (selectedFiles.size === 0) {
        fileSelectionStatus.innerHTML = '<span style="color: #f57c00;">⚠️ No files selected. Select files above to start monitoring.</span>';
    } else {
        const fileList = Array.from(selectedFiles).map(url => fileNames[url] || url).join(', ');
        fileSelectionStatus.innerHTML = `<span style="color: #2e7d32;">✓ Monitoring: ${fileList}</span>`;
    }
}

// Check if any selected files are available from senders
function checkForAvailableFiles() {
    if (currentRole !== 'receiver' || selectedFiles.size === 0) return;

    // This will be called from updateNetworkStatus
    // We'll check there if any sender has a selected file
}

// Initialize sender file selection checkboxes
function initSenderFileSelection() {
    const senderFileSelection = document.getElementById('senderFileSelection');
    if (!senderFileSelection) return;

    const checkboxes = senderFileSelection.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const fileUrl = e.target.value;
            if (e.target.checked) {
                senderSelectedFiles.add(fileUrl);
            } else {
                senderSelectedFiles.delete(fileUrl);
            }
            updateSenderFileSelectionStatus();
            renderFileStatusPanel();
        });
    });

    updateSenderFileSelectionStatus();
}

function updateSenderFileSelectionStatus() {
    const statusEl = document.getElementById('senderFileSelectionStatus');
    if (!statusEl) return;

    if (senderSelectedFiles.size === 0) {
        statusEl.innerHTML = '<span style="color: #f57c00;">⚠️ No files selected. Select files above to download and share.</span>';
    } else {
        const fileList = Array.from(senderSelectedFiles).map(url => fileNames[url] || url).join(', ');
        statusEl.innerHTML = `<span style="color: #2e7d32;">✓ Selected: ${fileList}</span>`;
    }
}

// ---------------------------------------------------------------------------
// Local-network-only P2P enforcement
//
// Goal: P2P data channels must only be established between peers on the same
// local network.  The signaling server (and this web app) are still reachable
// from the internet, so we cannot enforce this at the TCP/IP connection level.
// Instead we enforce it at the WebRTC ICE candidate layer:
//
//   1. getICEServers() returns NO external STUN servers.
//      Without STUN, a browser never discovers its public/NAT IP address, so it
//      can only produce "host" ICE candidates that carry its LAN IP.  Two peers
//      on different networks will each see only their own private addresses,
//      which are not routable across the internet → ICE negotiation fails →
//      no data channel is opened.
//
//   2. isLocalIP() / extractCandidateIP() filter outgoing ICE candidates before
//      they reach the signaling relay (defence-in-depth).  The server applies
//      the same filter when forwarding candidates (see server.js).
//
// What still works:
//   • Two peers on the same LAN exchange 192.168.x.x / 10.x.x.x host candidates
//     → direct WebRTC connection succeeds.
//   • The web app is served normally from the internet; only the P2P data
//     channel is restricted.
// ---------------------------------------------------------------------------

/**
 * Returns true when `ip` is a private / local address (RFC-1918, loopback,
 * link-local, or IPv6 equivalent).
 * @param {string} ip
 * @returns {boolean}
 */
function isLocalIP(ip) {
    if (!ip) return false;
    if (/^127\./.test(ip)) return true;                         // IPv4 loopback
    if (/^10\./.test(ip)) return true;                          // RFC-1918 Class A
    if (/^192\.168\./.test(ip)) return true;                    // RFC-1918 Class C
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;   // RFC-1918 Class B
    if (/^169\.254\./.test(ip)) return true;                    // IPv4 link-local
    if (/^::1$/.test(ip)) return true;                         // IPv6 loopback
    if (/^fe80:/i.test(ip)) return true;                       // IPv6 link-local
    if (/^fd[0-9a-f]{2}:/i.test(ip)) return true;             // IPv6 ULA
    return false;
}

/**
 * Parses an ICE candidate SDP string and returns its IP address, or null.
 * Format (RFC 5245):
 *   candidate:<foundation> <component> <transport> <priority> <ip> <port> typ <type> …
 * The IP is always at index 4 of the space-delimited fields.
 * @param {string} candidateStr
 * @returns {string|null}
 */
function extractCandidateIP(candidateStr) {
    if (!candidateStr || typeof candidateStr !== 'string') return null;
    const parts = candidateStr.split(' ');
    return parts.length > 4 ? parts[4] : null;
}

// ICE server configuration.
// External STUN servers are intentionally omitted: without STUN a browser
// cannot discover its public IP, so only LAN-local host candidates are
// generated.  This is the primary mechanism restricting P2P to the local
// network (see block comment above).
function getICEServers() {
    const iceServers = [];
    // No external STUN servers – adding them would allow peers to discover
    // their public IP and potentially connect across the internet.

    // Local TURN server (started by start.sh, only useful for localhost dev).
    // A production TURN server would defeat the local-network restriction and
    // must NOT be added here.
    const isLocalhost = window.location.hostname === 'localhost' ||
                        window.location.hostname === '127.0.0.1' ||
                        window.location.hostname === '';
    if (isLocalhost) {
        iceServers.push({
            urls: 'turn:localhost:3478',
            username: 'testuser',
            credential: 'testpass'
        });
    }

    return iceServers;
}

// Connect to WebSocket and auto-detect role
function connectSignaling() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    console.log('Connecting to WebSocket:', wsUrl);
    
    try {
        ws = new WebSocket(wsUrl);
    } catch (error) {
        console.error('Failed to create WebSocket:', error);
        updateStatus('error', 'Failed to create WebSocket: ' + error.message);
        return;
    }

    ws.onopen = () => {
        console.log('Connected to signaling server');
        
        // Check if we have a stored role from previous session
        const storedRole = localStorage.getItem('p2p_role');
        const cachedFileName = localStorage.getItem('p2p_cached_file');
        
        if (storedRole === 'sender' && cachedFileName) {
            // Restore sender role with cached file
            console.log('Restoring sender role with cached file:', cachedFileName);
            ws.send(JSON.stringify({ type: 'register', role: 'sender' }));
            currentRole = 'sender';
            updateRoleUI('sender');
            
            // Restore cached file after a short delay
            setTimeout(async () => {
                const cachedFile = await getCachedFile(cachedFileName);
                if (cachedFile) {
                    window.cachedFileMetadata = {
                        name: cachedFile.fileName,
                        size: cachedFile.fileSize,
                        mimeType: cachedFile.mimeType,
                        cacheControl: cachedFile.cacheControl,
                        etag: cachedFile.etag
                    };
                    // Don't load file data into memory - load from IndexedDB when needed
                    window.cachedFileData = null;
                    
                    // Don't create peer proactively - wait for receiver-initiated offers
                    // Peer will be created when receiver sends an offer (in handleOffer)
                    console.log('Sender restored - waiting for receiver-initiated offers');
                    
                    shareStatus.innerHTML = `<div class="status success">✓ Reconnected as sender. Ready to share: ${cachedFileName} (will connect when receiver initiates)</div>`;
                }
            }, 500);
        } else if (storedRole === 'receiver') {
            // Restore receiver role
            console.log('Restoring receiver role');
            ws.send(JSON.stringify({ type: 'register', role: 'receiver' }));
            currentRole = 'receiver';
            updateRoleUI('receiver');
            receiverStatus.innerHTML = '<div class="status info">Reconnected as receiver. Waiting for sender...</div>';
        } else {
            // No stored role, use auto-detection
            ws.send(JSON.stringify({ type: 'register', role: 'auto' }));
        }
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('Received message:', data.type);
            
            if (data.type === 'registered') {
                currentRole = data.role;
                updateRoleUI(data.role);
                
                // Store role in localStorage for persistence across reloads
                localStorage.setItem('p2p_role', data.role);
                
                if (data.role === 'sender') {
                    console.log('Registered as sender');
                    if (!localStorage.getItem('p2p_cached_file')) {
                        shareStatus.innerHTML = '<div class="status info">You are the sender. Download a file to start sharing.</div>';
                    }
                } else if (data.role === 'receiver') {
                    console.log('Registered as receiver');
                    receiverStatus.innerHTML = '<div class="status info">Waiting for sender to share a file...</div>';
                }
            } else if (data.type === 'sender-status') {
                // Response to check-sender request
                if (data.exists && currentRole !== 'sender') {
                    // Sender exists, switch to receiver
                    switchToReceiver();
                }
            } else if (data.type === 'offer') {
                // Handle offers: receiver-initiated offers go to senders, sender-initiated offers go to receivers
                console.log(`Received offer (role: ${data.role || 'none'}, currentRole: ${currentRole})`);
                if (data.role === 'receiver' && currentRole === 'sender') {
                    // Receiver-initiated offer: sender should handle it
                    console.log('✓ Sender received receiver-initiated offer, handling...');
                    handleOffer(data.offer);
                } else if (!data.role && currentRole === 'receiver') {
                    // Sender-initiated offer: receiver should handle it
                    console.log('✓ Receiver received sender-initiated offer, handling...');
                    handleOffer(data.offer);
                } else {
                    console.warn(`Ignoring offer: role mismatch (offer role: ${data.role}, current role: ${currentRole})`);
                }
            } else if (data.type === 'answer') {
                // Handle answers for both senders and receivers
                console.log(`Received answer (currentRole: ${currentRole}, hasPeer: ${!!peer}, isConnected: ${isConnected})`);
                
                if (!peer) {
                    console.warn('Received answer but no peer exists');
                    return;
                }
                
                if (peer.destroyed) {
                    console.warn('Received answer but peer is destroyed');
                    return;
                }
                
                // Check peer state before signaling
                if (isConnected) {
                    console.warn('Received answer but peer is already connected, ignoring');
                    return;
                }
                
                // Check if peer is an initiator (receiver-initiated connection)
                // For initiator peers, we need to signal the answer as remote description
                // But SimplePeer might be in wrong state - check signaling state first
                if (peer._pc && peer._pc.signalingState) {
                    const state = peer._pc.signalingState;
                    console.log(`Peer signaling state: ${state}`);
                    
                    // If already stable or have-local-offer, we can signal the answer
                    // If closed or failed, we can't
                    if (state === 'closed' || state === 'failed') {
                        console.warn('Peer connection in invalid state for answer:', state);
                        return;
                    }
                }
                
                // For receiver-initiated connections (initiator: true), signal the answer
                // SimplePeer with initiator: true expects the answer to be signaled as remote description
                if (currentRole === 'receiver') {
                    console.log('Receiver (initiator) received answer, checking state...');
                    
                    // CRITICAL: Check if peer exists and is valid
                    if (!peer || peer.destroyed) {
                        console.warn('No valid peer when receiving answer - ignoring');
                        return;
                    }
                    
                    // CRITICAL: Check signaling state FIRST before any other checks
                    let signalingState = null;
                    if (peer._pc && peer._pc.signalingState) {
                        signalingState = peer._pc.signalingState;
                        console.log(`Peer signaling state: ${signalingState}`);
                    } else {
                        console.warn('Cannot determine peer signaling state - may not be initialized yet');
                        // Wait a bit and check again
                        setTimeout(() => {
                            if (peer && peer._pc && peer._pc.signalingState) {
                                const newState = peer._pc.signalingState;
                                console.log(`Retry: Peer signaling state: ${newState}`);
                                if (newState === 'stable') {
                                    // Already stable, don't signal
                                    if (peer.connected && !isConnected) {
                                        isConnected = true;
                                        transferActive = true;
                                        receiverStatus.innerHTML = '<div class="status success">✓ Connected! Waiting for file...</div>';
                                    }
                                    return;
                                } else if (newState === 'have-local-offer') {
                                    // Now we can signal
                                    try {
                                        peer.signal(data.answer);
                                        console.log('Answer signaled successfully after wait');
                                    } catch (e) {
                                        console.error('Error signaling answer after wait:', e);
                                    }
                                }
                            }
                        }, 200);
                        return;
                    }
                    
                    // If already stable, NEVER signal - connection is complete or answer already processed
                    if (signalingState === 'stable') {
                        console.log('Peer already in stable state - answer already processed or connection complete');
                        // Check if connected and update state
                        setTimeout(() => {
                            if (peer && peer.connected && !isConnected) {
                                console.log('Connection already complete - updating state');
                                isConnected = true;
                                transferActive = true;
                                receiverStatus.innerHTML = '<div class="status success">✓ Connected! Waiting for file...</div>';
                            } else if (peer && !peer.connected) {
                                console.warn('Peer in stable state but not connected - may need to wait for ICE');
                            }
                        }, 100);
                        return; // CRITICAL: Don't signal - will cause error
                    }
                    
                    // Check if peer is already connected (might have connected via ICE before answer arrived)
                    if (peer.connected) {
                        console.log('Peer already connected - answer may have been handled automatically via ICE');
                        if (!isConnected) {
                            isConnected = true;
                            transferActive = true;
                            receiverStatus.innerHTML = '<div class="status success">✓ Connected! Waiting for file...</div>';
                        }
                        return; // Don't signal - already connected
                    }
                    
                    // Only signal if in 'have-local-offer' state (expected after sending offer)
                    if (signalingState !== 'have-local-offer') {
                        console.warn(`Cannot signal answer in state: ${signalingState} (expected 'have-local-offer') - skipping signal`);
                        // Don't try to signal - it will fail
                        // Connection might complete via ICE anyway
                        setTimeout(() => {
                            if (peer && peer.connected && !isConnected) {
                                console.log('Connection completed via ICE despite wrong signaling state');
                                isConnected = true;
                                transferActive = true;
                                receiverStatus.innerHTML = '<div class="status success">✓ Connected! Waiting for file...</div>';
                            }
                        }, 500);
                        return;
                    }
                    
                    // Double-check state right before signaling (defensive programming)
                    const finalState = peer._pc && peer._pc.signalingState ? peer._pc.signalingState : null;
                    if (finalState === 'stable') {
                        console.warn('State changed to stable before signaling - aborting');
                        return;
                    }
                    
                    // Only signal if we're in the correct state ('have-local-offer')
                    try {
                        console.log('Signaling answer to initiator peer (state: have-local-offer)...');
                        peer.signal(data.answer);
                        console.log('Answer signaled successfully to initiator peer');
                    } catch (e) {
                        console.error('Error signaling answer to initiator:', e);
                        // If error is about wrong state, check if connection completed anyway
                        if (e.message && (e.message.includes('wrong state') || e.message.includes('stable'))) {
                            console.warn('Peer in wrong state when signaling answer - checking if connection completed anyway');
                            setTimeout(() => {
                                if (peer && peer.connected && !isConnected) {
                                    console.log('Connection completed despite signaling error');
                                    isConnected = true;
                                    transferActive = true;
                                    receiverStatus.innerHTML = '<div class="status success">✓ Connected! Waiting for file...</div>';
                                }
                            }, 500);
                        }
                    }
                } else {
                    // For sender (non-initiator), signal answer normally
                    try {
                        peer.signal(data.answer);
                        console.log('Answer signaled successfully');
                    } catch (e) {
                        console.error('Error signaling answer:', e);
                    }
                }
            } else if (data.type === 'ice-candidate') {
                if (peer && data.candidate && !peer.destroyed) {
                    try {
                        peer.signal(data.candidate);
                    } catch (e) {
                        console.warn('Failed to signal ICE candidate (peer may be in wrong state):', e);
                    }
                }
            } else if (data.type === 'network-status') {
                // Update network status display
                updateNetworkStatus(data);
            }
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('error', 'WebSocket connection error');
    };

    ws.onclose = (event) => {
        console.log('WebSocket connection closed', event.code);
        if (event.code !== 1000 && event.code !== 1001) {
            // Not a normal close - attempt to reconnect
            console.log('Attempting to reconnect...');
            setTimeout(() => {
                connectSignaling();
            }, 2000);
        }
    };
}

function updateRoleUI(role) {
    roleBadge.textContent = role === 'sender' ? '📤 Sender' : '📥 Receiver';
    roleBadge.className = `role-badge ${role}`;
    
    if (role === 'sender') {
        senderUI.classList.remove('hidden');
        receiverUI.classList.add('hidden');
    } else {
        senderUI.classList.add('hidden');
        receiverUI.classList.remove('hidden');
    }
    
    switchRoleBtn.classList.remove('hidden');
    renderFileStatusPanel();
}

// Update network status display
function updateNetworkStatus(data) {
    if (!networkStatus || !data) return;
    
    // Show network status section
    networkStatus.classList.remove('hidden');
    
    // Update counts
    if (availableSendersEl) availableSendersEl.textContent = data.availableSenders || 0;
    if (busySendersEl) busySendersEl.textContent = data.busySenders || 0;
    if (totalReceiversEl) totalReceiversEl.textContent = data.totalReceivers || 0;
    
    // Update sender list and check for available files
    if (senderListEl && data.senders) {
        const allSenders = [...(data.senders.available || []), ...(data.senders.busy || [])];
        const availableFiles = new Set();
        
        if (allSenders.length > 0) {
            senderListEl.innerHTML = allSenders.map(sender => {
                const statusClass = sender.status === 'busy' ? 'busy' : 'available';
                const statusIcon = sender.status === 'busy' ? '⏳' : '✅';
                let fileName = '';
                let isSelectedFile = false;
                
                if (sender.fileName) {
                    // Check if this file matches any selected file
                    // Map filename back to URL (simplified - in production, sender should send URL)
                    const fileUrl = getFileUrlFromName(sender.fileName);
                    if (fileUrl && selectedFiles.has(fileUrl)) {
                        isSelectedFile = true;
                        availableFiles.add(fileUrl);
                        fileName = `<div class="sender-item-file" style="color: #2e7d32; font-weight: 600;">✓ File: ${sender.fileName} (SELECTED)</div>`;
                    } else {
                        fileName = `<div class="sender-item-file">File: ${sender.fileName}</div>`;
                    }
                }
                
                const highlightClass = isSelectedFile ? ' style="border: 2px solid #2e7d32;"' : '';
                return `
                    <div class="sender-item ${statusClass}"${highlightClass}>
                        ${statusIcon} Sender #${sender.id + 1} - ${sender.status === 'busy' ? 'Busy' : 'Available'}
                        ${fileName}
                    </div>
                `;
            }).join('');
            
            // Update file selection status with availability info
            if (currentRole === 'receiver' && fileSelectionStatus) {
                if (availableFiles.size > 0) {
                    const availableFileNames = Array.from(availableFiles).map(url => fileNames[url] || url).join(', ');
                    fileSelectionStatus.innerHTML += ` <span style="color: #2e7d32; font-weight: 600;">→ Available now!</span>`;
                }
            }
        } else {
            senderListEl.innerHTML = '<div style="color: #666; font-size: 12px;">No senders connected</div>';
        }
        
        // Auto-connect if selected files are available
        if (currentRole === 'receiver' && availableFiles.size > 0 && !isConnected && !transferActive && !peer && ws && ws.readyState === WebSocket.OPEN) {
            const availableFileNames = Array.from(availableFiles).map(url => fileNames[url] || url).join(', ');
            console.log(`Selected file(s) available: ${availableFileNames} - automatically initiating connection`);
            receiverStatus.innerHTML = `<div class="status info">Selected file(s) available: ${availableFileNames}. Connecting...</div>`;
            createReceiverPeer();
            return; // Don't continue with generic auto-connect
        }
    }
    
    // Auto-promote receiver to sender if no senders available
    // Only do this if we're currently a receiver and not actively receiving a file
    if (data.totalSenders === 0 && currentRole === 'receiver' && !transferActive && ws && ws.readyState === WebSocket.OPEN) {
        console.log('No senders available - automatically promoting receiver to sender');
        // Register as sender with the server
        ws.send(JSON.stringify({ type: 'register', role: 'sender' }));
        currentRole = 'sender';
        updateRoleUI('sender');
        localStorage.setItem('p2p_role', 'sender');
        receiverStatus.innerHTML = '<div class="status info">No senders available. You are now the sender. Download a file to start sharing.</div>';
        shareStatus.innerHTML = '<div class="status info">You are now the sender. Download a file to start sharing.</div>';
    }
    
    // Auto-connect receiver to any sender ONLY if files are selected
    // If no files selected, don't auto-connect
    if (currentRole === 'receiver' && selectedFiles.size === 0) {
        if (receiverStatus && !transferActive) {
            receiverStatus.innerHTML = '<div class="status info">Select files above to start monitoring and auto-downloading.</div>';
        }
        return; // Don't auto-connect if no files selected
    }
    
    // Auto-connect receiver to any sender (available or busy - busy senders are actively sharing)
    // Only if receiver is not already connected AND has selected files
    const totalActiveSenders = (data.availableSenders || 0) + (data.busySenders || 0);
    if (totalActiveSenders > 0 && currentRole === 'receiver' && selectedFiles.size > 0 && !isConnected && !transferActive && !peer && ws && ws.readyState === WebSocket.OPEN) {
        // Check if any sender has a selected file (already checked above, but double-check)
        const hasSelectedFile = data.senders && (
            data.senders.available?.some(s => selectedFiles.has(getFileUrlFromName(s.fileName))) ||
            data.senders.busy?.some(s => selectedFiles.has(getFileUrlFromName(s.fileName)))
        );
        
        if (hasSelectedFile) {
            console.log(`Active sender with selected file detected - automatically initiating connection`);
            createReceiverPeer();
        } else {
            if (receiverStatus && !transferActive) {
                receiverStatus.innerHTML = '<div class="status info">Waiting for selected file(s) to become available...</div>';
            }
        }
    }
}

// Helper function to map filename or URL to the canonical file URL
function getFileUrlFromName(fileName) {
    if (!fileName) return null;

    // 1. Direct URL match (sender now sends the file URL as identifier)
    if (fileNames[fileName]) return fileName;

    // 2. Hardcoded legacy matches
    if (fileName.includes('200mb') || fileName.includes('200MB') || fileName === 'test-file-200mb.bin') {
        return '/test-file-200mb.bin';
    }
    if (fileName.includes('100mb') || fileName.includes('100MB') || fileName === '100MB.bin') {
        return 'https://ash-speed.hetzner.com/100MB.bin';
    }

    // 3. Match by display name substring
    for (const [url, name] of Object.entries(fileNames)) {
        if (fileName.includes(name) || name.includes(fileName)) {
            return url;
        }
    }

    // 4. Match by last path segment of the URL (e.g. "Big_Buck_Bunny_1080_10s_30MB.mp4")
    for (const url of Object.keys(fileNames)) {
        const urlFile = decodeURIComponent(url.split('/').pop().split('?')[0]);
        if (urlFile && (fileName === urlFile || fileName.includes(urlFile) || urlFile.includes(fileName))) {
            return url;
        }
    }

    return null;
}

// Send sender status update to server
function sendSenderStatusUpdate(status, fileName = null) {
    if (ws && ws.readyState === WebSocket.OPEN && currentRole === 'sender') {
        ws.send(JSON.stringify({
            type: 'sender-status-update',
            status: status, // 'available' or 'busy'
            fileName: fileName
        }));
    }
}

function updateStatus(type, message) {
    // Update status based on current role
    const statusDiv = currentRole === 'sender' ? shareStatus : receiverStatus;
    if (statusDiv) {
        statusDiv.innerHTML = `<div class="status ${type}">${message}</div>`;
    } else {
        // Fallback if role not set yet
        console.error(`Status update (${type}): ${message}`);
    }
}

function switchToReceiver() {
    if (currentRole === 'sender') {
        // Only disconnect if not actively sharing
        if (peer && isConnected) {
            console.log('Warning: Disconnecting peer while sharing may interrupt transfer');
        }
        // Disconnect current peer if exists
        if (peer) {
            try {
                peer.destroy();
            } catch (e) {
                console.warn('Error destroying peer:', e);
            }
            peer = null;
            isConnected = false;
        }
        // Register as receiver with the server
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'register', role: 'receiver' }));
        }
        currentRole = 'receiver';
        updateRoleUI('receiver');
        localStorage.setItem('p2p_role', 'receiver');
        receiverStatus.innerHTML = '<div class="status info">Switched to receiver. Waiting for sender...</div>';
    }
}

function switchToSender() {
    if (currentRole === 'receiver') {
        // Register as sender with the server
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'register', role: 'sender' }));
        }
        currentRole = 'sender';
        updateRoleUI('sender');
        localStorage.setItem('p2p_role', 'sender');
        downloadStatus.innerHTML = '<div class="status info">Switched to sender. Download a file to start sharing.</div>';
        shareStatus.innerHTML = '<div class="status info">You are now the sender. Download a file to start sharing.</div>';
    }
}

switchRoleBtn.addEventListener('click', () => {
    if (currentRole === 'sender') {
        switchToReceiver();
    } else {
        switchToSender();
    }
});

// Stop functionality
function stopSender() {
    console.log('Stopping sender operations...');
    transferActive = false;
    senderStopRequested = true;

    // Mark sender as available
    sendSenderStatusUpdate('available');

    // Cancel download reader if active
    if (currentReader) {
        try {
            currentReader.cancel();
            currentReader = null;
        } catch (e) {
            console.warn('Error cancelling reader:', e);
        }
    }

    // Close peer connection
    if (peer) {
        try {
            peer.destroy();
            peer = null;
        } catch (e) {
            console.warn('Error destroying peer:', e);
        }
    }

    isConnected = false;
    metadataSent = false;
    sharingStarted = false;

    // Clean up memory
    cleanupMemoryAfterTransfer();

    downloadStatus.innerHTML = '<div class="status info">Operation stopped by user</div>';
    shareStatus.innerHTML = '<div class="status info">Sharing stopped</div>';
    downloadProgress.style.display = 'none';
    stopSenderBtn.style.display = 'none';
    downloadBtn.disabled = false;
}

function stopReceiver() {
    console.log('Stopping receiver operations...');
    transferActive = false;
    
    // Close peer connection
    if (peer) {
        try {
            peer.destroy();
            peer = null;
        } catch (e) {
            console.warn('Error destroying peer:', e);
        }
    }
    
    isConnected = false;
    fileMetadata = null;
    receivedChunks = [];
    totalReceived = 0;
    
    receiverStatus.innerHTML = '<div class="status info">Receiving stopped by user</div>';
    receiverProgress.style.display = 'none';
    stopReceiverBtn.style.display = 'none';
}

stopSenderBtn.addEventListener('click', stopSender);
stopReceiverBtn.addEventListener('click', stopReceiver);

// Detect and format specific error types
function formatWebRTCError(err) {
    const errorMsg = err.message || err.toString();
    const errorCode = err.code || err.errorCode;
    
    // Network/NAT/Firewall issues
    if (errorMsg.includes('ICE') || errorMsg.includes('candidate') || errorMsg.includes('connection') || 
        errorCode === 'ICE_CONNECTION_FAILED' || errorCode === 'ICE_CONNECTION_DISCONNECTED') {
        return {
            type: 'network',
            message: 'Network connectivity issue detected. This could be due to:\n' +
                     '• NAT/firewall blocking WebRTC connections\n' +
                     '• Network instability or packet loss\n' +
                     '• VPN or proxy interfering with WebRTC\n\n' +
                     'Try: Disable VPN, check firewall settings, or use a different network.'
        };
    }
    
    // WebRTC limits
    if (errorMsg.includes('quota') || errorMsg.includes('limit') || errorMsg.includes('exceeded') ||
        errorMsg.includes('too many') || errorCode === 'QUOTA_EXCEEDED_ERR') {
        return {
            type: 'webrtc_limit',
            message: 'WebRTC limit reached. This could be due to:\n' +
                     '• Too many simultaneous connections\n' +
                     '• Browser WebRTC quota exceeded\n' +
                     '• DataChannel buffer limit reached\n\n' +
                     'Try: Close other tabs/apps using WebRTC, restart browser, or wait a few minutes.'
        };
    }
    
    // Timeout issues
    if (errorMsg.includes('timeout') || errorMsg.includes('timed out') || errorCode === 'TIMEOUT') {
        return {
            type: 'timeout',
            message: 'Connection timeout detected. This could be due to:\n' +
                     '• File is too large for current network conditions\n' +
                     '• Slow network connection\n' +
                     '• Connection idle timeout\n\n' +
                     'Try: Use a smaller file, check your internet speed, or try again.'
        };
    }
    
    // IndexedDB quota
    if (errorMsg.includes('IndexedDB') || errorMsg.includes('quota') || errorCode === 22 || err.name === 'QuotaExceededError') {
        return {
            type: 'indexeddb_quota',
            message: 'IndexedDB storage quota exceeded. This could be due to:\n' +
                     '• Browser storage limit reached\n' +
                     '• File is too large for available storage\n' +
                     '• Other websites using storage quota\n\n' +
                     'Try: Clear browser storage, close other tabs, or use a browser with more storage.'
        };
    }
    
    // Generic error
    return {
        type: 'generic',
        message: `Connection error: ${errorMsg}`
    };
}

// Sender functionality - streaming download and auto-share (multi-file)
downloadBtn.addEventListener('click', async () => {
    if (currentRole !== 'sender') return;

    const filesToProcess = Array.from(senderSelectedFiles);
    if (filesToProcess.length === 0) {
        downloadStatus.innerHTML = '<div class="status error">Please select at least one file to download and share.</div>';
        return;
    }

    senderStopRequested = false;
    downloadBtn.disabled = true;
    stopSenderBtn.style.display = 'block';

    for (const selectedFileUrl of filesToProcess) {
        if (senderStopRequested) break;

        try {
            transferActive = true;
            downloadStatus.innerHTML = '<div class="status info">Downloading test file...</div>';
            downloadProgress.style.display = 'block';
            downloadProgressBar.style.width = '0%';

            // Mark sender as busy (will update with filename once we know it)
            sendSenderStatusUpdate('busy');

            // Initialize WebRTC connection early (before download starts)
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                connectSignaling();
                // Wait for WebSocket with timeout
                await new Promise((resolve) => {
                    let attempts = 0;
                    const maxAttempts = 50; // 5 seconds max wait
                    const checkConnection = setInterval(() => {
                        attempts++;
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            clearInterval(checkConnection);
                            console.log('WebSocket connected, proceeding with download');
                            resolve();
                        } else if (attempts >= maxAttempts) {
                            clearInterval(checkConnection);
                            console.warn('WebSocket connection timeout, proceeding anyway');
                            resolve(); // Continue anyway - download can start without WebSocket
                        }
                    }, 100);
                });
            }

            // Don't create peer proactively - wait for receiver-initiated offers
            // Peer will be created when receiver sends an offer (in handleOffer)
            console.log('Download starting - will create peer when receiver connects');

            const fileName = fileNames[selectedFileUrl] || 'Test File';

            downloadStatus.innerHTML = `<div class="status info">Downloading ${fileName}...</div>`;
            console.log(`Attempting to fetch: ${selectedFileUrl}`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                console.error('Fetch timeout after 30 seconds');
                controller.abort();
            }, 30000);

            let response = null;
            let directFetchFailed = false;

            // Check if it's an external URL (not same origin)
            const isExternalUrl = selectedFileUrl.startsWith('http://') || selectedFileUrl.startsWith('https://');
            const isSameOrigin = !isExternalUrl || // Relative URLs are same-origin
                selectedFileUrl.startsWith(window.location.origin) || // Same origin
                selectedFileUrl.startsWith('/'); // Relative path

            // For external URLs, use proxy directly to avoid CORS issues
            if (isExternalUrl && !isSameOrigin) {
                console.log(`${fileName} is external URL, using proxy to avoid CORS...`);
                directFetchFailed = true;
            } else {
                // Try direct fetch first for same-origin URLs
                try {
                    response = await fetch(selectedFileUrl, {
                        signal: controller.signal,
                        method: 'GET',
                        mode: 'cors',
                        cache: 'no-cache'
                    });

                    if (!response.ok) {
                        directFetchFailed = true;
                    }
                } catch (corsError) {
                    console.log(`${fileName} direct fetch failed (likely CORS), trying proxy...`);
                    directFetchFailed = true;
                }
            }

            if (directFetchFailed) {
                const fetchUrl = `/api/fetch-file?url=${encodeURIComponent(selectedFileUrl)}`;
                console.log(`Fetching via proxy: ${fetchUrl}`);
                try {
                    response = await fetch(fetchUrl, {
                        signal: controller.signal,
                        method: 'GET',
                        cache: 'no-cache'
                    });
                    console.log(`Proxy response status: ${response?.status}`);
                } catch (proxyError) {
                    clearTimeout(timeoutId);
                    console.error('Proxy fetch error:', proxyError);
                    throw new Error(`Failed to download ${fileName} via proxy: ${proxyError.message}`);
                }
            }

            clearTimeout(timeoutId);

            if (!response) {
                throw new Error(`Failed to download ${fileName}: No response received`);
            }

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                console.error(`HTTP error ${response.status}:`, errorText);
                throw new Error(`Failed to download ${fileName}: HTTP ${response.status} - ${errorText.substring(0, 100)}`);
            }

            console.log(`Successfully connected to ${fileName}, status: ${response.status}`);

            downloadStatus.innerHTML = `<div class="status info">Downloading ${fileName}... (sharing will start automatically)</div>`;
            const contentLength = parseInt(response.headers.get('content-length') || '52428800');
            const reader = response.body.getReader();
            currentReader = reader; // Track reader for cancellation

            // Get file metadata
            const contentType = response.headers.get('content-type') || 'application/octet-stream';
            const contentDisposition = response.headers.get('content-disposition') || '';
            const cacheControl = response.headers.get('cache-control') || '';
            const etag = response.headers.get('etag') || '';
            let downloadFileName = 'test-file.bin';

            // Extract filename from content-disposition, hardcoded fallbacks, or URL path
            const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
            if (filenameMatch) {
                downloadFileName = filenameMatch[1].replace(/['"]/g, '');
            } else if (selectedFileUrl.includes('100MB.bin')) {
                downloadFileName = '100MB.bin';
            } else if (selectedFileUrl.includes('test-file-200mb.bin')) {
                downloadFileName = 'test-file-200mb.bin';
            } else {
                // Extract filename from URL path (handles video files and other external URLs)
                const urlPathFile = selectedFileUrl.split('/').pop().split('?')[0];
                if (urlPathFile && urlPathFile.includes('.')) {
                    downloadFileName = decodeURIComponent(urlPathFile);
                }
            }

            const fileUrl = selectedFileUrl;
            setFileState(selectedFileUrl, 'downloading', 0);

            // Send the file URL as the identifier so receivers can match it precisely
            sendSenderStatusUpdate('busy', selectedFileUrl);

            // Start streaming download and sharing
            await streamDownloadAndShare(reader, contentLength, downloadFileName, contentType, cacheControl, etag, fileUrl);

        } catch (error) {
            console.error('Download error:', error);
            if (transferActive) {
                downloadStatus.innerHTML = `<div class="status error">Error: ${error.message}</div>`;
            }
            currentReader = null;
        }
    } // end for loop over selected files

    stopSenderBtn.style.display = 'none';
    downloadProgress.style.display = 'none';
    downloadBtn.disabled = false;
});

// Stream download and share simultaneously with proper chunking protocol
async function streamDownloadAndShare(reader, contentLength, fileName, contentType, cacheControl = '', etag = '', fileUrl = '') {
    // Check for existing transfer progress (resume functionality)
    let resumeState = null;
    if (fileUrl && db) {
        try {
            resumeState = await getTransferProgress(fileUrl);
            if (resumeState && resumeState.acknowledgedChunks) {
                // Handle both Set and Array formats
                const ackChunks = resumeState.acknowledgedChunks instanceof Set 
                    ? Array.from(resumeState.acknowledgedChunks) 
                    : resumeState.acknowledgedChunks;
                
                if (ackChunks.length > 0) {
                    console.log(`Resuming transfer: ${ackChunks.length} chunks already sent`);
                    // Restore acknowledged chunks
                    ackChunks.forEach(idx => {
                        senderChunkState.acknowledgedChunks.add(idx);
                    });
                    // Start from last acknowledged chunk + 1
                    senderChunkState.nextChunkIndex = Math.max(...ackChunks) + 1;
                    downloadStatus.innerHTML = `<div class="status info">Resuming transfer: ${ackChunks.length} chunks already sent</div>`;
                }
            }
        } catch (e) {
            console.warn('Failed to load transfer progress:', e);
        }
    }
    
    // Reset chunking state if not resuming
    if (!resumeState || !resumeState.acknowledgedChunks || 
        (resumeState.acknowledgedChunks instanceof Set && resumeState.acknowledgedChunks.size === 0) ||
        (Array.isArray(resumeState.acknowledgedChunks) && resumeState.acknowledgedChunks.length === 0)) {
        senderChunkState.nextChunkIndex = 0;
        senderChunkState.pendingChunks.clear();
        senderChunkState.acknowledgedChunks.clear();
    }
    
    const ackChunks = resumeState && resumeState.acknowledgedChunks 
        ? (resumeState.acknowledgedChunks instanceof Set ? Array.from(resumeState.acknowledgedChunks) : resumeState.acknowledgedChunks)
        : [];
    let receivedLength = ackChunks.length > 0 ? (ackChunks.length * senderChunkState.chunkSize) : 0;
    metadataSent = false;
    sharingStarted = false;
    
    // Initialize diagnostic tracking
    window.transferDiagnostics = {
        fileSize: contentLength,
        fileName: fileName,
        totalBytesDownloaded: receivedLength, // Bytes downloaded from HTTP
        totalBytesSent: receivedLength, // Bytes sent to WebRTC (updated when chunks sent)
        totalBytesAcknowledged: receivedLength, // Bytes acknowledged by receiver (most accurate)
        connectionStartTime: null,
        chunksSent: ackChunks.length,
        chunksAcknowledged: ackChunks.length,
        fileUrl: fileUrl // Store URL for resume
    };

    // Start downloading immediately, don't wait for peer connection
    // The file will be downloaded and shared when a receiver connects
    console.log('Starting file download (will share when receiver connects)...');
    
    // Send metadata when connection is ready (but don't block download)
    const sendMetadataWhenReady = async () => {
        // Wait for connection with timeout (don't wait forever)
        let attempts = 0;
        const maxAttempts = 300; // 30 seconds max wait
        while (transferActive && attempts < maxAttempts) {
            if (isConnected && peer && peer.connected) {
                // If we have direct data channel access, wait for it to be open
                if (senderChunkState.dataChannel) {
                    if (senderChunkState.dataChannel.readyState === 'open') {
                        break;
                    }
                } else {
                    // Otherwise, connection is ready
                    break;
                }
            }
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (!transferActive) return;
        
        // Send metadata if connected
        if (peer && isConnected && peer.connected) {
        const metadata = {
            type: 'file-metadata',
            name: fileName,
            size: contentLength,
            mimeType: contentType,
            chunkSize: senderChunkState.chunkSize,
            cacheControl: cacheControl,
            etag: etag
        };
        try {
            if (senderChunkState.dataChannel && senderChunkState.dataChannel.readyState === 'open') {
                senderChunkState.dataChannel.send(JSON.stringify(metadata));
            } else if (peer && isConnected && peer.connected && !peer.destroyed) {
                peer.send(JSON.stringify(metadata));
            } else {
                console.warn('Cannot send metadata: peer not ready');
                return;
            }
            metadataSent = true;
            sharingStarted = true;
            shareStatus.innerHTML = '<div class="status success">✓ Sharing started! Streaming file with flow control...</div>';
            setFileState(fileUrl, 'sharing', 0);
            console.log('Metadata sent, sharing started');
        } catch (e) {
            console.error('Failed to send metadata:', e);
            // Don't return - continue downloading even if metadata send fails
            // Will retry when connection is established
        }
        } else {
            console.log('No receiver connected yet, downloading file first...');
            shareStatus.innerHTML = '<div class="status info">Downloading file... Will share when receiver connects.</div>';
        }
    };
    
    // Start metadata sending in background (non-blocking)
    sendMetadataWhenReady();
    
    // Buffer for accumulating chunks to fixed size (optimized to avoid copying)
    let chunkBuffer = new Uint8Array(0);
    let lastUIUpdate = 0;
    const UI_UPDATE_INTERVAL = isSafari ? 500 : 200; // Slower updates for Safari
    
    // Accumulate raw bytes so we can cache the complete file after download,
    // allowing a late-connecting receiver to get the file via shareCachedFile().
    const senderFileData = [];

    // If resuming, skip already-acknowledged chunks (ackChunks already declared above)
    let bytesToSkip = ackChunks.length > 0 ? (ackChunks.length * senderChunkState.chunkSize) : 0;
    let bytesSkipped = 0;

    while (true) {
        if (!transferActive) break;

        const { done, value } = await reader.read();
        if (done) break;
        senderFileData.push(value); // accumulate for caching
        
        // Skip bytes that were already sent (if resuming)
        if (bytesSkipped < bytesToSkip) {
            const skipAmount = Math.min(value.length, bytesToSkip - bytesSkipped);
            bytesSkipped += skipAmount;
            if (skipAmount < value.length) {
                // Partial skip - use remaining data
                const remaining = value.slice(skipAmount);
                receivedLength += remaining.length;
                
                if (chunkBuffer.length === 0) {
                    chunkBuffer = new Uint8Array(remaining);
                } else {
                    const newBuffer = new Uint8Array(chunkBuffer.length + remaining.length);
                    newBuffer.set(chunkBuffer);
                    newBuffer.set(remaining, chunkBuffer.length);
                    chunkBuffer = newBuffer;
                }
            }
            // Continue to next iteration if we skipped everything
            if (skipAmount >= value.length) {
                receivedLength += value.length;
                // Update downloaded bytes tracking
                if (window.transferDiagnostics) {
                    window.transferDiagnostics.totalBytesDownloaded = receivedLength;
                }
                continue;
            }
        } else {
            receivedLength += value.length;
            // Update downloaded bytes tracking
            if (window.transferDiagnostics) {
                window.transferDiagnostics.totalBytesDownloaded = receivedLength;
            }
        }
        
        // Throttle UI updates to reduce DOM manipulation overhead
        const now = Date.now();
        if (now - lastUIUpdate > UI_UPDATE_INTERVAL) {
            const downloadedMB = (receivedLength / 1024 / 1024).toFixed(2);
            const totalMB = (contentLength / 1024 / 1024).toFixed(2);
            const downloadedProgress = (receivedLength / contentLength) * 100;
            
            // Get acknowledged bytes (most accurate for what receiver has)
            const acknowledgedBytes = window.transferDiagnostics?.totalBytesAcknowledged || 0;
            const acknowledgedMB = (acknowledgedBytes / 1024 / 1024).toFixed(2);
            const acknowledgedProgress = acknowledgedBytes > 0 ? (acknowledgedBytes / contentLength) * 100 : 0;
            
            downloadProgressBar.style.width = downloadedProgress + '%';
            downloadStatus.innerHTML = `<div class="status info">
                Downloaded: ${downloadedMB} MB / ${totalMB} MB (${downloadedProgress.toFixed(1)}%)<br>
                Shared: ${acknowledgedMB} MB / ${totalMB} MB (${acknowledgedProgress.toFixed(1)}%)
            </div>`;
            setFileState(fileUrl, 'downloading', downloadedProgress);
            lastUIUpdate = now;
        }
        
        // Optimize buffer: use views instead of copying when possible
        if (chunkBuffer.length === 0) {
            chunkBuffer = new Uint8Array(value);
        } else {
            // Only create new buffer when necessary
            const newBuffer = new Uint8Array(chunkBuffer.length + value.length);
            newBuffer.set(chunkBuffer);
            newBuffer.set(value, chunkBuffer.length);
            chunkBuffer = newBuffer;
        }
        
        // Send complete chunks immediately to free memory
        // Note: chunks will be queued if no receiver is connected yet
        while (chunkBuffer.length >= senderChunkState.chunkSize && transferActive) {
            const chunkData = chunkBuffer.slice(0, senderChunkState.chunkSize);
            chunkBuffer = chunkBuffer.slice(senderChunkState.chunkSize);
            
            // Send chunk (will queue if no connection)
            await sendChunkWithFlowControl(chunkData, senderChunkState.nextChunkIndex, contentLength, receivedLength);
            senderChunkState.nextChunkIndex++;
            
            // Periodic cleanup of acknowledged chunks to free memory
            if (senderChunkState.nextChunkIndex % 100 === 0) {
                cleanupAcknowledgedChunks();
            }
            
            // If no connection yet, don't block - continue downloading
            // Chunks are queued and will be sent when receiver connects
            if (!isConnected || !peer || !peer.connected) {
                // Small yield to prevent blocking
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    }
    
    // Final UI update
    const downloadedMB = (receivedLength / 1024 / 1024).toFixed(2);
    const totalMB = (contentLength / 1024 / 1024).toFixed(2);
    const downloadedProgress = (receivedLength / contentLength) * 100;
    
    // Get acknowledged bytes (most accurate for what receiver has)
    const acknowledgedBytes = window.transferDiagnostics?.totalBytesAcknowledged || 0;
    const acknowledgedMB = (acknowledgedBytes / 1024 / 1024).toFixed(2);
    const acknowledgedProgress = acknowledgedBytes > 0 ? (acknowledgedBytes / contentLength) * 100 : 0;
    
    downloadProgressBar.style.width = downloadedProgress + '%';
    downloadStatus.innerHTML = `<div class="status info">
        Downloaded: ${downloadedMB} MB / ${totalMB} MB (${downloadedProgress.toFixed(1)}%)<br>
        Shared: ${acknowledgedMB} MB / ${totalMB} MB (${acknowledgedProgress.toFixed(1)}%)
    </div>`;
    
    // Send remaining buffer as final chunk
    if (chunkBuffer.length > 0 && transferActive) {
        await sendChunkWithFlowControl(chunkBuffer, senderChunkState.nextChunkIndex, contentLength, receivedLength);
        senderChunkState.nextChunkIndex++;
    }
    
    // Clear chunk buffer to free memory
    chunkBuffer = null;

    // ── Cache complete file so a late-connecting receiver can still get it ──
    // Do this BEFORE the ACK wait so the data is persisted immediately.
    if (senderFileData.length > 0 && db) {
        try {
            const totalBytes = senderFileData.reduce((s, c) => s + c.length, 0);
            const combined = new Uint8Array(totalBytes);
            let off = 0;
            for (const chunk of senderFileData) { combined.set(chunk, off); off += chunk.length; }
            senderFileData.length = 0; // free memory after combining

            // cacheFileInDB reads metadata.name / metadata.size (same shape as fileMetadata)
            const fileMeta = { name: fileName, size: contentLength, mimeType: contentType, cacheControl, etag };
            await cacheFileInDB(fileMeta, combined);
            window.cachedFileMetadata = fileMeta;
            localStorage.setItem('p2p_cached_file', fileName);
            console.log(`Sender file cached to IndexedDB: ${fileName} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
        } catch (e) {
            // DuplicateError if already cached — that's fine, existing entry is usable
            if (!e?.name?.includes('ConstraintError')) {
                console.warn('Failed to cache sender file:', e);
            }
        }
    }

    // Wait for all chunks to be acknowledged
    await waitForAllChunksAcknowledged();
    
    // Save final transfer progress (all chunks acknowledged)
    if (window.transferDiagnostics && window.transferDiagnostics.fileUrl && db) {
        try {
            await saveTransferProgress(window.transferDiagnostics.fileUrl, senderChunkState.nextChunkIndex - 1, true);
            // Clear transfer progress after successful completion
            await clearTransferProgress(window.transferDiagnostics.fileUrl);
        } catch (e) {
            console.warn('Failed to save final transfer progress:', e);
        }
    }
    
    // Clean up memory after transfer
    cleanupMemoryAfterTransfer();
    
    // (File caching already done above, before waitForAllChunksAcknowledged)
    
    // Mark sender as available after successful transfer
    sendSenderStatusUpdate('available', fileName);
    
    currentReader = null;
    
    if (transferActive) {
        downloadStatus.innerHTML = `<div class="status success">✓ File downloaded and shared! (${(receivedLength / 1024 / 1024).toFixed(2)} MB)</div>`;
        shareStatus.innerHTML = '<div class="status success">✓ File shared successfully!</div>';
        setFileState(fileUrl, 'complete');
        if (isVideoUrl(fileUrl)) {
            const proxyUrl = `/api/fetch-file?url=${encodeURIComponent(fileUrl)}`;
            showVideoPlayer(proxyUrl, fileNames[fileUrl] || 'Video');
        }
    }
}

// Clean up memory after transfer completes
function cleanupMemoryAfterTransfer() {
    // Clear pending chunks (they're all acknowledged now)
    senderChunkState.pendingChunks.clear();
    
    // Clear acknowledged chunks set (no longer needed)
    senderChunkState.acknowledgedChunks.clear();
    
    // Clear transfer diagnostics
    if (window.transferDiagnostics) {
        delete window.transferDiagnostics;
    }
    
    // Force garbage collection hint (Safari may honor this)
    if (window.gc) {
        try {
            window.gc();
        } catch (e) {
            // Ignore if not available
        }
    }
    
    console.log('Memory cleaned up after transfer');
}

// Send chunk with flow control and acknowledgment tracking
async function sendChunkWithFlowControl(chunkData, chunkIndex, totalSize, receivedLength) {
    const dataChannel = senderChunkState.dataChannel;
    const useDirectChannel = dataChannel && dataChannel.readyState === 'open';
    
    if (!useDirectChannel && (!peer || !isConnected || !peer.connected)) {
        // Throttle this log — fires for every chunk when no receiver is connected yet,
        // which is the normal sender-first state; logging once per 2 s is enough.
        const now = Date.now();
        if (!senderChunkState._lastNoConnLog || now - senderChunkState._lastNoConnLog > 2000) {
            console.log(`No receiver connected yet, buffering chunk ${chunkIndex} (${senderChunkState.pendingChunks.size + 1} pending)`);
            senderChunkState._lastNoConnLog = now;
        }
        senderChunkState.pendingChunks.set(chunkIndex, chunkData);
        return;
    }

    // Don't send chunks before metadata — receiver must get file-metadata first.
    // metadataSent is set by sendMetadataWhenReady() which runs concurrently.
    if (!metadataSent) {
        senderChunkState.pendingChunks.set(chunkIndex, chunkData);
        return;
    }
    
    // Connection is ready — reset the throttle so any future gap gets logged again
    senderChunkState._lastNoConnLog = null;

    // Encode chunk index as 4-byte header + chunk data (binary format)
    const header = new ArrayBuffer(4);
    const headerView = new DataView(header);
    headerView.setUint32(0, chunkIndex, true); // little-endian
    
    // Combine header + chunk data
    const message = new Uint8Array(4 + chunkData.length);
    message.set(new Uint8Array(header), 0);
    message.set(chunkData, 4);
    const messageSize = message.length;
    
    // Flow control: wait for buffer space before sending
    if (useDirectChannel && (dataChannel.bufferedAmount + messageSize) > senderChunkState.maxBufferSize) {
        // Prefer event-driven wait (bufferedamountlow) over polling when threshold is set
        if (dataChannel.bufferedAmountLowThreshold > 0) {
            await new Promise(resolve => {
                const onLow = () => { dataChannel.removeEventListener('bufferedamountlow', onLow); resolve(); };
                dataChannel.addEventListener('bufferedamountlow', onLow);
                // Safety fallback: also poll every 5ms in case the event misfires
                const poll = setInterval(() => {
                    if (!transferActive || dataChannel.bufferedAmount + messageSize <= senderChunkState.maxBufferSize) {
                        clearInterval(poll);
                        dataChannel.removeEventListener('bufferedamountlow', onLow);
                        resolve();
                    }
                }, 5);
            });
        } else {
            // Fallback: 5ms polling
            let waitCount = 0;
            while (transferActive && (dataChannel.bufferedAmount + messageSize) > senderChunkState.maxBufferSize) {
                waitCount++;
                if (waitCount % 20 === 0) {
                    console.log(`Buffer full (${(dataChannel.bufferedAmount / 1024).toFixed(0)} KB), waiting...`);
                }
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }
    }
    // No artificial delay for non-direct-channel path — rely on peer.send() backpressure
    
    if (!transferActive) return;
    
    try {
        // Check bufferedAmount one more time right before sending
        if (useDirectChannel && dataChannel.bufferedAmount > senderChunkState.maxBufferSize) {
            // Still too full, queue for later
            senderChunkState.pendingChunks.set(chunkIndex, chunkData);
            return;
        }
        
        // Send binary data directly (SimplePeer supports this)
        if (useDirectChannel) {
            dataChannel.send(message.buffer);
        } else if (peer && peer.connected && !peer.destroyed) {
            peer.send(message);
        } else {
            // Peer not ready, queue for retry
            senderChunkState.pendingChunks.set(chunkIndex, chunkData);
            return;
        }
        senderChunkState.pendingChunks.set(chunkIndex, chunkData); // Keep for retry until ACK
        
        // Update diagnostics
        if (window.transferDiagnostics) {
            window.transferDiagnostics.totalBytesSent += chunkData.length;
            window.transferDiagnostics.chunksSent++;
            // Note: totalBytesAcknowledged is updated in handleChunkAck
        }
        
        // Throttle UI updates to reduce DOM manipulation overhead
        const now = Date.now();
        if (!window.lastShareUIUpdate) window.lastShareUIUpdate = 0;
        const shareUIInterval = isSafari ? 500 : 200; // Slower for Safari
        if (now - window.lastShareUIUpdate > shareUIInterval) { // Update max every 200ms
            const sentMB = (receivedLength / 1024 / 1024).toFixed(2);
            const totalMB = (totalSize / 1024 / 1024).toFixed(2);
            const progress = (receivedLength / totalSize) * 100;
            const bufferInfo = useDirectChannel ? 
                `<br>Buffer: ${(dataChannel.bufferedAmount / 1024).toFixed(2)} KB` : '';
            shareStatus.innerHTML = `
                <div class="status info">
                    Streaming: ${sentMB} MB / ${totalMB} MB (${progress.toFixed(1)}%)${bufferInfo}
                </div>
            `;
            window.lastShareUIUpdate = now;
        }
    } catch (e) {
        // If send fails due to queue full, queue for retry
        if (e.message && e.message.includes('queue is full')) {
            console.warn(`Queue full, queuing chunk ${chunkIndex} for retry`);
            senderChunkState.pendingChunks.set(chunkIndex, chunkData);
            // Wait a bit before trying next chunk
            await new Promise(resolve => setTimeout(resolve, 200));
        } else {
            console.error('Failed to send chunk:', e);
            senderChunkState.pendingChunks.set(chunkIndex, chunkData);
        }
    }
}

// Wait for all chunks to be acknowledged
async function waitForAllChunksAcknowledged() {
    // No point waiting if there is no active receiver connection
    if (!peer || !isConnected) {
        console.log('No receiver connected — skipping ACK wait');
        return;
    }

    const maxWaitTime = 60000; // 60 seconds max wait
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime && transferActive) {
        // Check if all chunks are acknowledged
        let allAcked = true;
        for (let i = 0; i < senderChunkState.nextChunkIndex; i++) {
            if (!senderChunkState.acknowledgedChunks.has(i)) {
                allAcked = false;
                break;
            }
        }
        
        if (allAcked) {
            console.log('All chunks acknowledged!');
            return;
        }
        
        // Retry unacknowledged chunks
        for (let i = 0; i < senderChunkState.nextChunkIndex; i++) {
            if (!senderChunkState.acknowledgedChunks.has(i) && senderChunkState.pendingChunks.has(i)) {
                const chunkData = senderChunkState.pendingChunks.get(i);
                await sendChunkWithFlowControl(chunkData, i, window.transferDiagnostics?.fileSize || 0, 0);
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// Handle ACK from receiver
function handleChunkAck(chunkIndex) {
    senderChunkState.acknowledgedChunks.add(chunkIndex);
    senderChunkState.pendingChunks.delete(chunkIndex);
    
    // Update acknowledged bytes tracking (most accurate measure of what receiver has)
    if (window.transferDiagnostics) {
        // Calculate total acknowledged bytes based on highest acknowledged chunk
        // This is more accurate than incrementing, especially for resume scenarios
        const chunkSize = senderChunkState.chunkSize;
        const maxAcknowledgedIndex = Math.max(...Array.from(senderChunkState.acknowledgedChunks));
        const acknowledgedChunks = senderChunkState.acknowledgedChunks.size;
        
        // Calculate bytes: (number of full chunks * chunkSize) + handle last partial chunk
        // For now, assume all chunks are full size (last chunk handled separately if needed)
        const totalAcknowledgedBytes = acknowledgedChunks * chunkSize;
        
        // Cap at file size to handle last partial chunk
        window.transferDiagnostics.totalBytesAcknowledged = Math.min(
            totalAcknowledgedBytes,
            window.transferDiagnostics.fileSize
        );
        window.transferDiagnostics.chunksAcknowledged = acknowledgedChunks;
        
        // Update share status with acknowledged progress
        const now = Date.now();
        if (!window.lastShareUIUpdate) window.lastShareUIUpdate = 0;
        const shareUIInterval = isSafari ? 500 : 200;
        if (now - window.lastShareUIUpdate > shareUIInterval) {
            const acknowledgedMB = (window.transferDiagnostics.totalBytesAcknowledged / 1024 / 1024).toFixed(2);
            const totalMB = (window.transferDiagnostics.fileSize / 1024 / 1024).toFixed(2);
            const progress = (window.transferDiagnostics.totalBytesAcknowledged / window.transferDiagnostics.fileSize) * 100;
            shareStatus.innerHTML = `
                <div class="status info">
                    Shared: ${acknowledgedMB} MB / ${totalMB} MB (${progress.toFixed(1)}%)
                </div>
            `;
            window.lastShareUIUpdate = now;
            if (window.transferDiagnostics?.fileUrl) {
                setFileState(window.transferDiagnostics.fileUrl, 'sharing', progress);
            }
        }
    }
    
    // Save transfer progress to IndexedDB for resume functionality
    if (window.transferDiagnostics && window.transferDiagnostics.fileUrl && db) {
        // Save progress every 50 chunks to avoid too frequent writes
        if (chunkIndex % 50 === 0) {
            saveTransferProgress(window.transferDiagnostics.fileUrl, chunkIndex).catch(e => {
                console.warn('Failed to save transfer progress:', e);
            });
        }
    }
    
    // Clean up old acknowledged chunks periodically to free memory
    if (chunkIndex % 100 === 0) {
        cleanupAcknowledgedChunks();
    }
}

// Clean up old acknowledged chunks to free memory
function cleanupAcknowledgedChunks() {
    const now = Date.now();
    // Only cleanup every 5 seconds to avoid overhead
    if (now - senderChunkState.lastCleanupTime < 5000) return;
    
    senderChunkState.lastCleanupTime = now;
    
    // Remove old acknowledged chunks (keep only recent ones for retry logic)
    // Keep only chunks from the last 1000 indices
    const maxKeepIndex = Math.max(0, senderChunkState.nextChunkIndex - 1000);
    for (let i = 0; i < maxKeepIndex; i++) {
        senderChunkState.acknowledgedChunks.delete(i);
    }
    
    // Limit pending chunks size
    if (senderChunkState.pendingChunks.size > senderChunkState.maxPendingChunks) {
        // Remove oldest pending chunks (they'll be retried if needed)
        const sortedIndices = Array.from(senderChunkState.pendingChunks.keys()).sort((a, b) => a - b);
        const toRemove = sortedIndices.slice(0, senderChunkState.pendingChunks.size - senderChunkState.maxPendingChunks);
        toRemove.forEach(idx => senderChunkState.pendingChunks.delete(idx));
    }
}

// Sharing is now automatic - shareBtn is hidden in HTML
if (shareBtn) {
    shareBtn.style.display = 'none';
}

function createPeer() {
    // Don't create a new peer if one already exists and is connected
    if (peer && isConnected) {
        console.log('Peer already exists and is connected');
        return;
    }
    
    // Destroy existing peer if it exists but isn't connected
    if (peer) {
        console.log('Destroying existing peer before creating new one');
        try {
            peer.destroy();
        } catch (e) {
            console.warn('Error destroying old peer:', e);
        }
        peer = null;
        isConnected = false;
    }
    
    peer = new SimplePeer({
        initiator: true,
        trickle: false,
        config: {
            iceServers: getICEServers()
        }
    });

    peer.on('signal', (data) => {
        console.log('Sending signal:', data.type);
        if (ws && ws.readyState === WebSocket.OPEN) {
            if (data.type === 'offer') {
                ws.send(JSON.stringify({ type: 'offer', offer: data }));
            } else if (data.candidate) {
                // Local-network filter: only forward candidates with private/local IPs.
                // data.candidate.candidate is the raw SDP candidate string.
                const candidateIP = extractCandidateIP(data.candidate?.candidate);
                if (isLocalIP(candidateIP)) {
                    ws.send(JSON.stringify({ type: 'ice-candidate', candidate: data, role: 'sender' }));
                } else {
                    console.debug('Dropped non-local sender ICE candidate (ip=' + candidateIP + ')');
                }
            }
        }
    });

    peer.on('connect', () => {
        console.log('WebRTC connected!');
        isConnected = true;
        if (window.transferDiagnostics) {
            window.transferDiagnostics.connectionStartTime = Date.now();
        }
        
        // Get the data channel for flow control
        // SimplePeer stores it in _channel or we can access via _pc
        if (peer._channel) {
            senderChunkState.dataChannel = peer._channel;
            // Set low threshold so the browser signals us when there's room again
            peer._channel.bufferedAmountLowThreshold = 1 * 1024 * 1024; // 1MB
            console.log('DataChannel ready for flow control');
        } else if (peer._pc) {
            // Try to get from RTCPeerConnection
            try {
                if (peer._pc.getDataChannels) {
                    const dataChannels = peer._pc.getDataChannels();
                    if (dataChannels && dataChannels.length > 0) {
                        senderChunkState.dataChannel = dataChannels[0];
                        console.log('DataChannel ready for flow control (via getDataChannels)');
                    }
                }
            } catch (e) {
                console.warn('Could not access data channel directly:', e);
            }
        }
        
        shareStatus.innerHTML = '<div class="status success">✓ Connected! Ready to share...</div>';
        
        // Start keep-alive ping for large files to prevent timeout
        if (window.keepAliveInterval) {
            clearInterval(window.keepAliveInterval);
        }
        window.keepAliveInterval = setInterval(() => {
            if (peer && isConnected && peer.connected && !peer.destroyed) {
                try {
                    if (senderChunkState.dataChannel && senderChunkState.dataChannel.readyState === 'open') {
                        senderChunkState.dataChannel.send(JSON.stringify({ type: 'keep-alive', timestamp: Date.now() }));
                    } else if (peer.connected && !peer.destroyed) {
                        peer.send(JSON.stringify({ type: 'keep-alive', timestamp: Date.now() }));
                    }
                } catch (e) {
                    console.warn('Failed to send keep-alive:', e);
                }
            }
        }, 30000);
    });
    
    // Handle data channel messages (ACKs)
    peer.on('data', (data) => {
        try {
            const text = new TextDecoder().decode(data);
            const message = JSON.parse(text);
            
            if (message.type === 'chunk-ack') {
                handleChunkAck(message.chunkIndex);
            } else if (message.type === 'keep-alive' || message.type === 'keep-alive-ack') {
                // Ignore keep-alive
            }
        } catch (e) {
            // Not JSON, ignore
        }
    });

    peer.on('error', (err) => {
        console.error('Peer error:', err);
        console.error('Error details:', {
            message: err.message,
            code: err.code,
            name: err.name,
            stack: err.stack
        });
        // Don't show error if it's just a close error during normal operation or user-initiated
        const errorMsg = err.message || err.toString();
        if (!errorMsg.includes('Close called') && !errorMsg.includes('User-Initiated') && !errorMsg.includes('User-Initiated Abort')) {
            const formattedError = formatWebRTCError(err);
            shareStatus.innerHTML = `<div class="status error">${formattedError.message.replace(/\n/g, '<br>')}</div>`;
        } else {
            console.log('Ignoring expected close error:', errorMsg);
        }
    });

    peer.on('close', () => {
        console.log('Peer connection closed (sender)');
        const wasActive = transferActive && metadataSent && sharingStarted;
        isConnected = false;
        transferActive = false;
        
        // Clear keep-alive interval
        if (window.keepAliveInterval) {
            clearInterval(window.keepAliveInterval);
            window.keepAliveInterval = null;
        }
        // Only show error if we were actively sharing
        if (wasActive) {
            // Get diagnostic info if available
            const diagnostics = window.transferDiagnostics || {};
            const sentMB = diagnostics.totalBytesSent ? (diagnostics.totalBytesSent / 1024 / 1024).toFixed(2) : 'unknown';
            const totalMB = diagnostics.fileSize ? (diagnostics.fileSize / 1024 / 1024).toFixed(2) : 'unknown';
            const progress = diagnostics.fileSize && diagnostics.totalBytesSent ? 
                ((diagnostics.totalBytesSent / diagnostics.fileSize) * 100).toFixed(1) : 'unknown';
            const duration = diagnostics.connectionStartTime ? 
                ((Date.now() - diagnostics.connectionStartTime) / 1000).toFixed(1) : 'unknown';
            
            let errorMsg = '<strong>Connection closed unexpectedly during transfer</strong><br><br>';
            
            if (sentMB !== 'unknown' && totalMB !== 'unknown') {
                errorMsg += '<strong>Transfer details:</strong><br>';
                errorMsg += `• Sent: ${sentMB} MB / ${totalMB} MB (${progress}%)<br>`;
                if (duration !== 'unknown') {
                    errorMsg += `• Connection duration: ${duration}s<br>`;
                }
                errorMsg += '<br>';
                
                // Context-aware error diagnosis - prioritize file size over progress
                const fileSizeMB = parseFloat(totalMB);
                const progressPercent = parseFloat(progress);
                
                if (fileSizeMB > 1000) {
                    // Very large file - likely timeout or buffer issues
                    errorMsg += '<strong>Likely cause: Large file timeout</strong><br>';
                    errorMsg += `The file is very large (${totalMB} MB) and may have exceeded limits:<br>`;
                    errorMsg += '• Browser WebRTC connection timeout (large files need stable, long connections)<br>';
                    errorMsg += '• Network instability during long transfer<br>';
                    errorMsg += '• DataChannel buffer overflow or memory limits<br>';
                    errorMsg += '• Connection idle timeout during slow transfer<br><br>';
                    errorMsg += '<strong>Recommendations:</strong><br>';
                    errorMsg += '• Try a smaller file first to test connection stability<br>';
                    errorMsg += '• Ensure both browsers stay open and active<br>';
                    errorMsg += '• Use a stable, fast network connection<br>';
                    errorMsg += '• Consider splitting large files into smaller chunks<br>';
                } else if (progressPercent < 5 && fileSizeMB < 100) {
                    // Small file, very early failure - likely connection issue
                    errorMsg += '<strong>Likely cause: Connection establishment failure</strong><br>';
                    errorMsg += 'The connection failed very early, suggesting:<br>';
                    errorMsg += '• NAT/firewall blocking WebRTC connections<br>';
                    errorMsg += '• Network connectivity issues<br>';
                    errorMsg += '• VPN or proxy interfering with WebRTC<br><br>';
                } else if (progressPercent < 10) {
                    // Early failure - could be connection or network
                    errorMsg += '<strong>Likely cause: Early connection failure</strong><br>';
                    errorMsg += 'The connection failed early in the transfer:<br>';
                    errorMsg += '• Network connectivity issue (NAT/firewall)<br>';
                    errorMsg += '• Connection establishment problems<br>';
                    errorMsg += '• Network instability or packet loss<br><br>';
                } else {
                    // Mid-transfer failure
                    errorMsg += '<strong>Possible causes:</strong><br>';
                    errorMsg += '• Network connectivity issue (NAT/firewall blocking WebRTC)<br>';
                    errorMsg += '• Receiver disconnected or network interrupted<br>';
                    errorMsg += '• Browser WebRTC connection timeout<br><br>';
                }
            } else {
                errorMsg += '<strong>Possible causes:</strong><br>';
                errorMsg += '• Network connectivity issue (NAT/firewall blocking WebRTC)<br>';
                errorMsg += '• Receiver disconnected or network interrupted<br>';
                errorMsg += '• Browser WebRTC connection timeout<br><br>';
            }
            
            errorMsg += '<strong>Try:</strong> Check network connection, ensure receiver is still connected, or try again.';
            
            shareStatus.innerHTML = `<div class="status error">${errorMsg}</div>`;
        }
    });
}

function sendFile() {
    if (!downloadedFile || !isConnected) return;

    const CHUNK_SIZE = 16 * 1024;
    const fileReader = new FileReader();
    let offset = 0;
    let totalSent = 0;

    const metadata = {
        type: 'file-metadata',
        name: downloadedFile.name,
        size: downloadedFile.size,
        mimeType: downloadedFile.type
    };
    
    peer.send(JSON.stringify(metadata));

    fileReader.onload = (e) => {
        const chunk = e.target.result;
        peer.send(new Uint8Array(chunk));
        totalSent += chunk.byteLength;
        
        const progress = (totalSent / downloadedFile.size) * 100;
        shareStatus.innerHTML = `
            <div class="status info">
                Sending: ${(totalSent / 1024 / 1024).toFixed(2)} MB / ${(downloadedFile.size / 1024 / 1024).toFixed(2)} MB (${progress.toFixed(1)}%)
            </div>
        `;

        offset += CHUNK_SIZE;
        
        if (offset < downloadedFile.size) {
            readNextChunk();
        } else {
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

// Receiver functionality
// Create receiver peer connection as initiator (receiver-initiated connection)
function createReceiverPeer() {
    // Don't create if already connected or peer exists
    if (peer && isConnected) {
        console.log('Receiver peer already exists and connected');
        return;
    }
    
    // Destroy existing peer if exists
    if (peer) {
        console.log('Destroying existing receiver peer');
        try {
            peer.destroy();
        } catch (e) {
            console.warn('Error destroying peer:', e);
        }
        peer = null;
        isConnected = false;
    }
    
    // Reset receiver state
    _completeDownloadRunning = false;
    fileMetadata = null;
    receivedChunks = [];
    totalReceived = 0;
    receiverChunkState.receivedChunkMap.clear();
    
    console.log('Creating receiver peer connection (initiator)...');
    receiverStatus.innerHTML = '<div class="status info">Connecting to available sender...</div>';
    
    peer = new SimplePeer({
        initiator: true, // Receiver initiates connection
        trickle: false,
        config: {
            iceServers: getICEServers()
        }
    });
    
    peer.on('signal', (data) => {
        console.log('Receiver sending signal:', data.type, data);
        if (ws && ws.readyState === WebSocket.OPEN && !peer.destroyed) {
            if (data.type === 'offer') {
                // Send offer to sender (receiver-initiated)
                console.log('Sending receiver-initiated offer to server');
                ws.send(JSON.stringify({ type: 'offer', offer: data, role: 'receiver' }));
            } else if (data.type === 'answer') {
                // This shouldn't happen for initiator, but handle it just in case
                console.warn('Receiver (initiator) generated answer, this is unexpected');
            } else if (data.candidate) {
                // Local-network filter: only forward candidates with private/local IPs.
                const candidateIP = extractCandidateIP(data.candidate?.candidate);
                if (isLocalIP(candidateIP)) {
                    console.log('Sending ICE candidate from receiver (ip=' + candidateIP + ')');
                    ws.send(JSON.stringify({ type: 'ice-candidate', candidate: data, role: 'receiver' }));
                } else {
                    console.debug('Dropped non-local receiver ICE candidate (ip=' + candidateIP + ')');
                }
            }
        } else {
            console.warn('Cannot send signal: WebSocket not ready or peer destroyed', {
                wsReady: ws && ws.readyState === WebSocket.OPEN,
                peerDestroyed: peer && peer.destroyed
            });
        }
    });
    
    peer.on('connect', () => {
        console.log('WebRTC connected! (receiver-initiated)');
        isConnected = true;
        transferActive = true;
        receiverStatus.innerHTML = '<div class="status success">✓ Connected! Waiting for file...</div>';
        receiverProgress.style.display = 'block';
        stopReceiverBtn.style.display = 'block';
        
        // Start keep-alive ping
        if (window.keepAliveInterval) {
            clearInterval(window.keepAliveInterval);
        }
        window.keepAliveInterval = setInterval(() => {
            if (peer && isConnected && peer.connected && !peer.destroyed) {
                try {
                    peer.send(JSON.stringify({ type: 'keep-alive-ack', timestamp: Date.now() }));
                } catch (e) {
                    console.warn('Failed to send keep-alive ack:', e);
                }
            }
        }, 30000);
    });
    
    peer.on('data', (data) => {
        if (transferActive) {
            // Convert to Uint8Array for processing
            let buffer;
            if (data instanceof ArrayBuffer) {
                buffer = new Uint8Array(data);
            } else if (data instanceof Uint8Array) {
                buffer = data;
            } else if (Buffer.isBuffer && Buffer.isBuffer(data)) {
                buffer = new Uint8Array(data);
            } else {
                buffer = new Uint8Array(data);
            }
            
            // Check if we have metadata
            if (!fileMetadata) {
                // Try to parse as JSON metadata
                try {
                    const text = new TextDecoder().decode(buffer);
                    const message = JSON.parse(text);
                    
                    if (message.type === 'file-metadata') {
                        fileMetadata = message;
                        receivedChunks = [];
                        totalReceived = 0;
                        receiverChunkState.receivedChunkMap.clear();
                        receiverChunkState.expectedChunkIndex = 0;
                        currentReceivingUrl = getFileUrlFromName(message.name);
                        if (currentReceivingUrl) setFileState(currentReceivingUrl, 'receiving', 0);

                        // Clear previous chunks from IndexedDB
                        if (db) {
                            clearIndexedDB().catch(e => console.warn('Failed to clear IndexedDB:', e));
                        }

                        const cacheInfo = message.cacheControl ? 
                            ` (Cache-Control: ${message.cacheControl})` : '';
                        receiverStatus.innerHTML = `<div class="status info">Receiving: ${message.name} (${(message.size / 1024 / 1024).toFixed(2)} MB)${cacheInfo}</div>`;
                        return;
                    }
                } catch (e) {
                    console.warn('Expected metadata but got binary data');
                    return;
                }
            } else {
                // Check if it's a small JSON message (ACK or keep-alive)
                if (buffer.length < 100) {
                    try {
                        const text = new TextDecoder().decode(buffer);
                        const message = JSON.parse(text);
                        
                        if (message.type === 'chunk-ack') {
                            handleChunkAck(message.chunkIndex);
                            return;
                        }
                        if (message.type === 'keep-alive' || message.type === 'keep-alive-ack') {
                            return;
                        }
                    } catch (e) {
                        // Not JSON, treat as binary chunk
                    }
                }
                
                // Binary chunk format: 4-byte index header + data
                if (buffer.length >= 4) {
                    const chunkIndex = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, true);
                    const chunkData = buffer.slice(4);
                    handleReceivedChunk({ index: chunkIndex, data: chunkData });
                    return;
                }
            }
            
            // Fallback: try legacy handler
            try {
                const text = new TextDecoder().decode(buffer);
                const message = JSON.parse(text);
                if (message.type === 'file-metadata') {
                    handleReceivedData(text);
                }
            } catch (e) {
                // Legacy binary format
                handleReceivedData(data);
            }
        }
    });
    
    peer.on('error', (err) => {
        console.error('Peer error (receiver):', err);
        console.error('Error details:', {
            message: err.message,
            code: err.code,
            name: err.name,
            stack: err.stack
        });
        const errorMsg = err.message || err.toString();
        if (!errorMsg.includes('Close called') && !errorMsg.includes('User-Initiated') && !errorMsg.includes('User-Initiated Abort')) {
            const formattedError = formatWebRTCError(err);
            receiverStatus.innerHTML = `<div class="status error">${formattedError.message.replace(/\n/g, '<br>')}</div>`;
        } else {
            console.log('Ignoring expected close error:', errorMsg);
        }
    });
    
    peer.on('close', () => {
        console.log('Peer connection closed (receiver)');
        const wasActive = transferActive && fileMetadata && totalReceived > 0 && totalReceived < fileMetadata.size;
        isConnected = false;
        transferActive = false;
        
        // Clear keep-alive interval
        if (window.keepAliveInterval) {
            clearInterval(window.keepAliveInterval);
            window.keepAliveInterval = null;
        }
        // Only show error if we were actively receiving
        if (wasActive) {
            const fileSizeMB = parseFloat((fileMetadata.size / 1024 / 1024).toFixed(2));
            const receivedMB = (totalReceived / 1024 / 1024).toFixed(2);
            const progressPercent = parseFloat(((totalReceived / fileMetadata.size) * 100).toFixed(1));
            
            let errorMsg = `<strong>Connection closed unexpectedly during transfer</strong><br><br>`;
            errorMsg += `<strong>Transfer details:</strong><br>`;
            errorMsg += `• Received: ${receivedMB} MB / ${fileSizeMB.toFixed(2)} MB (${progressPercent.toFixed(1)}%)<br><br>`;
            
            if (fileSizeMB > 1000) {
                errorMsg += '<strong>Likely cause: Large file timeout</strong><br>';
                errorMsg += `The file is very large (${fileSizeMB.toFixed(2)} MB) and may have exceeded limits:<br>`;
                errorMsg += '• Browser WebRTC connection timeout<br>';
                errorMsg += '• Network instability during long transfer<br>';
                errorMsg += '• DataChannel buffer overflow or memory limits<br><br>';
                errorMsg += '<strong>Recommendations:</strong><br>';
                errorMsg += '• Try a smaller file first<br>';
                errorMsg += '• Ensure both browsers stay open<br>';
                errorMsg += '• Use a stable network connection<br>';
            } else if (progressPercent < 5 && fileSizeMB < 100) {
                errorMsg += '<strong>Likely cause: Connection establishment failure</strong><br>';
                errorMsg += 'The connection failed very early:<br>';
                errorMsg += '• NAT/firewall blocking WebRTC connections<br>';
                errorMsg += '• Network connectivity issues<br>';
                errorMsg += '• VPN or proxy interfering with WebRTC<br><br>';
                errorMsg += '<strong>Try:</strong> Check firewall settings, disable VPN, or use a different network.';
            } else if (progressPercent < 10) {
                errorMsg += '<strong>Likely cause: Early connection failure</strong><br>';
                errorMsg += 'The connection failed early:<br>';
                errorMsg += '• Network connectivity issue (NAT/firewall)<br>';
                errorMsg += '• Connection establishment problems<br>';
                errorMsg += '• Network instability or packet loss<br><br>';
                errorMsg += '<strong>Try:</strong> Check firewall settings, disable VPN, or use a different network.';
            } else {
                errorMsg += '<strong>Possible causes:</strong><br>';
                errorMsg += '• Network instability or packet loss<br>';
                errorMsg += '• Connection interrupted mid-transfer<br>';
                errorMsg += '• Browser WebRTC limit reached<br><br>';
                errorMsg += '<strong>Try:</strong> Check your network connection, restart browser, or try again.';
            }
            
            receiverStatus.innerHTML = `<div class="status error">${errorMsg}</div>`;
        }
    });
}

// Track retry attempts to prevent infinite loops
let handleOfferRetryCount = 0;
const MAX_HANDLE_OFFER_RETRIES = 3;

function handleOffer(offer) {
    // Reset retry count if this is a fresh call (not a retry)
    if (!arguments.callee._isRetry) {
        handleOfferRetryCount = 0;
    }
    arguments.callee._isRetry = false;
    
    // Prevent infinite retry loops
    if (handleOfferRetryCount >= MAX_HANDLE_OFFER_RETRIES) {
        console.error('Max retries reached for handleOffer - aborting');
        const errorMsg = 'Failed to establish connection after multiple attempts';
        if (currentRole === 'sender') {
            shareStatus.innerHTML = `<div class="status error">${errorMsg}</div>`;
        } else {
            receiverStatus.innerHTML = `<div class="status error">${errorMsg}</div>`;
        }
        return;
    }
    
    // Don't create a new peer if one already exists and is connected
    if (peer && isConnected) {
        console.log('Peer already exists and connected, ignoring new offer');
        return;
    }
    
    // Don't create a new peer if we're a receiver and already initiated a connection
    // (we should be waiting for an answer, not handling offers)
    if (currentRole === 'receiver' && peer && !isConnected) {
        console.log('Receiver already has pending peer connection, ignoring offer');
        return;
    }
    
    // For senders: only handle receiver-initiated offers
    // Don't create peer proactively - only respond to receiver offers
    if (currentRole === 'sender' && !peer) {
        console.log('Sender received receiver-initiated offer - will create peer to respond');
    }
    
    // Destroy existing peer if exists but not connected
    if (peer) {
        console.log('Peer already exists but not connected, destroying old one');
        try {
            peer.destroy();
        } catch (e) {
            console.warn('Error destroying old peer:', e);
        }
        peer = null;
        isConnected = false;
    }
    
    const isSender = currentRole === 'sender';
    
    if (isSender) {
        // Sender handling receiver-initiated offer
        console.log('Sender handling receiver-initiated offer');
        shareStatus.innerHTML = '<div class="status info">Receiver connecting... Preparing to share...</div>';
    } else {
        // Receiver handling sender-initiated offer
        // Reset receiver state
        fileMetadata = null;
        receivedChunks = [];
        totalReceived = 0;
    }
    
    // Create new peer
    peer = new SimplePeer({
        initiator: false,
        trickle: false,
        config: {
            iceServers: getICEServers()
        }
    });
    
    // Ensure peer is not null before setting up handlers
    if (!peer) {
        console.error('Failed to create peer');
        return;
    }

    peer.on('signal', (data) => {
        console.log(`handleOffer: Sending signal: ${data.type} (isSender: ${isSender})`);
        if (ws && ws.readyState === WebSocket.OPEN && !peer.destroyed) {
            if (data.type === 'answer') {
                // Include role so server knows where to forward the answer
                const role = isSender ? 'sender' : 'receiver';
                console.log(`Sending answer with role: ${role} (sender responding to receiver-initiated offer)`);
                ws.send(JSON.stringify({ type: 'answer', answer: data, role: role }));
            } else if (data.candidate) {
                // Local-network filter: only forward candidates with private/local IPs.
                const candidateIP = extractCandidateIP(data.candidate?.candidate);
                const role = isSender ? 'sender' : 'receiver';
                if (isLocalIP(candidateIP)) {
                    ws.send(JSON.stringify({ type: 'ice-candidate', candidate: data, role: role }));
                } else {
                    console.debug('Dropped non-local ICE candidate (ip=' + candidateIP + ', role=' + role + ')');
                }
            }
        } else {
            console.warn('Cannot send signal: WebSocket not ready or peer destroyed', {
                wsReady: ws && ws.readyState === WebSocket.OPEN,
                peerDestroyed: peer && peer.destroyed
            });
        }
    });

    // Wait for peer to be ready before signaling offer
    // SimplePeer needs the RTCPeerConnection to be initialized before setting remote description
    const signalOffer = () => {
        if (!peer || peer.destroyed || isConnected) {
            if (isConnected) {
                console.log('Peer already connected, ignoring offer signal');
            }
            return;
        }
        
        try {
            // Validate offer format before signaling
            if (!offer || (typeof offer !== 'object' && typeof offer !== 'string')) {
                console.error('Invalid offer format:', offer);
                const errorMsg = 'Invalid connection offer received';
                if (isSender) {
                    shareStatus.innerHTML = `<div class="status error">${errorMsg}</div>`;
                } else {
                    receiverStatus.innerHTML = `<div class="status error">${errorMsg}</div>`;
                }
                return;
            }
            
            // Check if offer has required SDP fields
            const offerStr = typeof offer === 'string' ? offer : (offer.sdp || JSON.stringify(offer));
            if (!offerStr || (!offerStr.includes('v=') && !offerStr.includes('m='))) {
                console.error('Offer missing SDP content:', offer);
                const errorMsg = 'Invalid SDP in connection offer';
                if (isSender) {
                    shareStatus.innerHTML = `<div class="status error">${errorMsg}</div>`;
                } else {
                    receiverStatus.innerHTML = `<div class="status error">${errorMsg}</div>`;
                }
                return;
            }
            
            // For a newly created peer with initiator: false, state will be 'stable' initially
            // This is normal - we can signal the offer immediately
            // Only check state if peer was reused (which we don't do anymore)
            
            console.log('Signaling offer to peer (initiator: false)');
            try {
                if (!peer || peer.destroyed) {
                    console.warn('Peer destroyed before signaling offer');
                    return;
                }
                peer.signal(offer);
                console.log('Offer signaled successfully');
            } catch (e) {
                console.error('Error signaling offer to non-initiator peer:', e);
                const errorMsg = e.message || e.toString();
                
                // If error is about wrong state, increment retry count and retry
                if (errorMsg.includes('wrong state') || errorMsg.includes('stable')) {
                    handleOfferRetryCount++;
                    console.warn(`Peer in wrong state when signaling offer (retry ${handleOfferRetryCount}/${MAX_HANDLE_OFFER_RETRIES})`);
                    
                    // Destroy peer
                    try {
                        if (peer && !peer.destroyed) {
                            peer.destroy();
                        }
                    } catch (destroyErr) {
                        console.warn('Error destroying peer:', destroyErr);
                    }
                    peer = null;
                    
                    // Retry after a delay if under max retries
                    if (handleOfferRetryCount < MAX_HANDLE_OFFER_RETRIES) {
                        setTimeout(() => {
                            if (currentRole === 'sender' && offer) {
                                console.log('Retrying handleOffer after state error');
                                arguments.callee._isRetry = true;
                                handleOffer(offer);
                            }
                        }, 300);
                    } else {
                        console.error('Max retries reached - aborting');
                        const errorMsg = 'Failed to establish connection after multiple attempts';
                        if (currentRole === 'sender') {
                            shareStatus.innerHTML = `<div class="status error">${errorMsg}</div>`;
                        } else {
                            receiverStatus.innerHTML = `<div class="status error">${errorMsg}</div>`;
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Error signaling offer:', e);
            const errorMsg = e.message || e.toString();
            
            // Handle specific error cases
            if (errorMsg.includes('no pending remote description') || 
                errorMsg.includes('wrong state') ||
                errorMsg.includes('InvalidStateError')) {
                console.warn('Peer in wrong state for signaling offer:', errorMsg);
                
                // Don't retry immediately - this usually means the peer is in an invalid state
                // Destroy and let the other side retry if needed
                try {
                    if (peer && !peer.destroyed) {
                        peer.destroy();
                    }
                } catch (destroyErr) {
                    console.warn('Error destroying peer:', destroyErr);
                }
                peer = null;
                isConnected = false;
                
                const statusMsg = 'Connection state error. Please try again.';
                if (isSender) {
                    shareStatus.innerHTML = `<div class="status error">${statusMsg}</div>`;
                } else {
                    receiverStatus.innerHTML = `<div class="status error">${statusMsg}</div>`;
                }
            } else {
                if (isSender) {
                    shareStatus.innerHTML = `<div class="status error">Connection error: ${errorMsg}</div>`;
                } else {
                    receiverStatus.innerHTML = `<div class="status error">Connection error: ${errorMsg}</div>`;
                }
            }
        }
    };
    
    // Try to signal immediately, but if peer isn't ready, wait a bit
    if (peer._pc && peer._pc.signalingState) {
        // Peer connection exists, signal immediately
        signalOffer();
    } else {
        // Wait for peer connection to be initialized
        setTimeout(signalOffer, 100);
    }

    peer.on('connect', () => {
        console.log('WebRTC connected!');
        isConnected = true;
        transferActive = true;
        
        if (isSender) {
            // Sender: auto-share cached file when receiver connects
            shareStatus.innerHTML = '<div class="status success">✓ Receiver connected! Starting to share...</div>';
            console.log('Receiver connected - auto-sharing cached file');
            
            // Small delay to ensure connection is stable
            setTimeout(() => {
                if (window.cachedFileMetadata && window.cachedFileMetadata.name) {
                    shareCachedFile(window.cachedFileMetadata.name);
                } else {
                    // Check if we're downloading a file - if so, sharing will start automatically
                    if (currentReader) {
                        console.log('File download in progress - sharing will start automatically');
                        shareStatus.innerHTML = '<div class="status info">File download in progress - sharing will start automatically when ready</div>';
                    } else {
                        shareStatus.innerHTML = '<div class="status error">No cached file to share</div>';
                    }
                }
            }, 500);
        } else {
            // Receiver: wait for file
            receiverStatus.innerHTML = '<div class="status success">✓ Connected! Receiving file...</div>';
            receiverProgress.style.display = 'block';
            stopReceiverBtn.style.display = 'block';
        }
        
        // Start keep-alive ping for large files to prevent timeout
        if (window.keepAliveInterval) {
            clearInterval(window.keepAliveInterval);
        }
        window.keepAliveInterval = setInterval(() => {
            if (peer && isConnected && peer.connected && !peer.destroyed) {
                try {
                    // Send keep-alive response (echo back)
                    peer.send(JSON.stringify({ type: 'keep-alive-ack', timestamp: Date.now() }));
                } catch (e) {
                    console.warn('Failed to send keep-alive ack:', e);
                }
            }
        }, 30000); // Every 30 seconds
    });

    peer.on('data', (data) => {
        if (transferActive) {
            // Convert to Uint8Array for processing
            let buffer;
            if (data instanceof ArrayBuffer) {
                buffer = new Uint8Array(data);
            } else if (data instanceof Uint8Array) {
                buffer = data;
            } else {
                buffer = new Uint8Array(data);
            }
            
            // Check if it's a binary chunk (starts with 4-byte index header)
            // or JSON metadata/ACK
            if (buffer.length >= 4 && !fileMetadata) {
                // Might be metadata - try JSON first
                try {
                    const text = new TextDecoder().decode(buffer);
                    const message = JSON.parse(text);
                    
                    if (message.type === 'file-metadata') {
                        handleReceivedData(text);
                        return;
                    }
                    if (message.type === 'keep-alive' || message.type === 'keep-alive-ack') {
                        return;
                    }
                } catch (e) {
                    // Not JSON, might be binary chunk but we need metadata first
                    console.warn('Received binary data before metadata');
                    return;
                }
            }
            
            // If we have metadata, check if it's a binary chunk or JSON ACK
            if (fileMetadata) {
                // Check if it's a small JSON message (ACK or keep-alive)
                if (buffer.length < 100) {
                    try {
                        const text = new TextDecoder().decode(buffer);
                        const message = JSON.parse(text);
                        
                        if (message.type === 'chunk-ack') {
                            handleChunkAck(message.chunkIndex);
                            return;
                        }
                        if (message.type === 'keep-alive' || message.type === 'keep-alive-ack') {
                            return;
                        }
                    } catch (e) {
                        // Not JSON, treat as binary chunk
                    }
                }
                
                // Binary chunk format: 4-byte index header + data
                if (buffer.length >= 4) {
                    const chunkIndex = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, true);
                    const chunkData = buffer.slice(4);
                    handleReceivedChunk({ index: chunkIndex, data: chunkData });
                    return;
                }
            }
            
            // Fallback: try legacy handler
            try {
                const text = new TextDecoder().decode(buffer);
                const message = JSON.parse(text);
                if (message.type === 'file-metadata') {
                    handleReceivedData(text);
                }
            } catch (e) {
                // Legacy binary format
                handleReceivedData(data);
            }
        }
    });

    peer.on('error', (err) => {
        console.error('Peer error (receiver):', err);
        console.error('Error details:', {
            message: err.message,
            code: err.code,
            name: err.name,
            stack: err.stack
        });
        
        const errorMsg = err.message || err.toString();
        
        // Ignore "wrong state: stable" errors - these happen when answer is signaled but peer is already stable
        // The connection might still work via ICE
        // Also ignore ERR_SET_LOCAL_DESCRIPTION errors with "stable" state
        if ((errorMsg.includes('wrong state') && errorMsg.includes('stable')) ||
            (err.code === 'ERR_SET_LOCAL_DESCRIPTION' && errorMsg.includes('stable'))) {
            console.warn('Ignoring "wrong state: stable" error (code: ' + err.code + ') - checking if connection completed anyway');
            // Don't show error immediately - wait to see if connection completes
            setTimeout(() => {
                if (peer && peer.connected && !isConnected) {
                    console.log('Connection completed despite state error - updating state');
                    isConnected = true;
                    transferActive = true;
                    receiverStatus.innerHTML = '<div class="status success">✓ Connected! Waiting for file...</div>';
                } else if (peer && !peer.connected) {
                    // Check again after a longer delay - ICE might take time
                    setTimeout(() => {
                        if (peer && peer.connected && !isConnected) {
                            console.log('Connection completed after delay - updating state');
                            isConnected = true;
                            transferActive = true;
                            receiverStatus.innerHTML = '<div class="status success">✓ Connected! Waiting for file...</div>';
                        } else if (!peer || !peer.connected) {
                            console.warn('Connection did not complete - this error may be harmless if connection works via ICE');
                            // Don't show error - connection might still work
                        }
                    }, 2000);
                }
            }, 500);
            return; // Don't show error - connection might still work
        }
        
        // Don't show error if it's just a close error during normal operation or user-initiated
        if (!errorMsg.includes('Close called') && !errorMsg.includes('User-Initiated') && !errorMsg.includes('User-Initiated Abort')) {
            const formattedError = formatWebRTCError(err);
            receiverStatus.innerHTML = `<div class="status error">${formattedError.message.replace(/\n/g, '<br>')}</div>`;
        } else {
            console.log('Ignoring expected close error:', errorMsg);
        }
    });

    peer.on('close', () => {
        console.log('Peer connection closed (receiver)');
        const wasActive = transferActive && fileMetadata && totalReceived > 0 && totalReceived < fileMetadata.size;
        isConnected = false;
        transferActive = false;
        
        // Clear keep-alive interval
        if (window.keepAliveInterval) {
            clearInterval(window.keepAliveInterval);
            window.keepAliveInterval = null;
        }
        // Only show error if we were actively receiving
        if (wasActive) {
            const fileSizeMB = parseFloat((fileMetadata.size / 1024 / 1024).toFixed(2));
            const receivedMB = (totalReceived / 1024 / 1024).toFixed(2);
            const progressPercent = parseFloat(((totalReceived / fileMetadata.size) * 100).toFixed(1));
            
            // Determine likely cause - prioritize file size over progress
            let errorMsg = `<strong>Connection closed unexpectedly during transfer</strong><br><br>`;
            errorMsg += `<strong>Transfer details:</strong><br>`;
            errorMsg += `• Received: ${receivedMB} MB / ${fileSizeMB.toFixed(2)} MB (${progressPercent.toFixed(1)}%)<br><br>`;
            
            if (fileSizeMB > 1000) {
                // Very large file - likely timeout or buffer issues
                errorMsg += '<strong>Likely cause: Large file timeout</strong><br>';
                errorMsg += `The file is very large (${fileSizeMB.toFixed(2)} MB) and may have exceeded limits:<br>`;
                errorMsg += '• Browser WebRTC connection timeout (large files need stable, long connections)<br>';
                errorMsg += '• Network instability during long transfer<br>';
                errorMsg += '• DataChannel buffer overflow or memory limits<br>';
                errorMsg += '• Connection idle timeout during slow transfer<br><br>';
                errorMsg += '<strong>Recommendations:</strong><br>';
                errorMsg += '• Try a smaller file first to test connection stability<br>';
                errorMsg += '• Ensure both browsers stay open and active<br>';
                errorMsg += '• Use a stable, fast network connection<br>';
                errorMsg += '• Consider splitting large files into smaller chunks<br>';
            } else if (progressPercent < 5 && fileSizeMB < 100) {
                // Small file, very early failure - likely connection issue
                errorMsg += '<strong>Likely cause: Connection establishment failure</strong><br>';
                errorMsg += 'The connection failed very early, suggesting:<br>';
                errorMsg += '• NAT/firewall blocking WebRTC connections<br>';
                errorMsg += '• Network connectivity issues<br>';
                errorMsg += '• VPN or proxy interfering with WebRTC<br><br>';
                errorMsg += '<strong>Try:</strong> Check firewall settings, disable VPN, or use a different network.';
            } else if (progressPercent < 10) {
                // Early failure - could be connection or network
                errorMsg += '<strong>Likely cause: Early connection failure</strong><br>';
                errorMsg += 'The connection failed early in the transfer:<br>';
                errorMsg += '• Network connectivity issue (NAT/firewall)<br>';
                errorMsg += '• Connection establishment problems<br>';
                errorMsg += '• Network instability or packet loss<br><br>';
                errorMsg += '<strong>Try:</strong> Check firewall settings, disable VPN, or use a different network.';
            } else {
                // Mid-transfer failure
                errorMsg += '<strong>Possible causes:</strong><br>';
                errorMsg += '• Network instability or packet loss<br>';
                errorMsg += '• Connection interrupted mid-transfer<br>';
                errorMsg += '• Browser WebRTC limit reached<br><br>';
                errorMsg += '<strong>Try:</strong> Check your network connection, restart browser, or try again.';
            }
            
            receiverStatus.innerHTML = `<div class="status error">${errorMsg}</div>`;
        }
    });

}

// Handle received chunk with sequence number
function handleReceivedChunk(message) {
    if (!fileMetadata) {
        console.warn('Received chunk before metadata');
        return;
    }
    
    const chunkIndex = message.index;
    // chunkData is already Uint8Array from the handler
    const chunkData = message.data instanceof Uint8Array ? message.data : new Uint8Array(message.data);
    
    // Check if chunk was already received (duplicate detection)
    const wasAlreadyReceived = receiverChunkState.receivedChunkMap.has(chunkIndex);
    
    // Store chunk in map (handles out-of-order chunks, overwrites duplicates)
    receiverChunkState.receivedChunkMap.set(chunkIndex, chunkData);
    
    // Only increment totalReceived if this is a new chunk (not a duplicate)
    if (!wasAlreadyReceived) {
        totalReceived += chunkData.length;
    }
    
    // Store in IndexedDB
    if (db) {
        storeChunkInDB(chunkIndex, chunkData).catch(e => {
            console.error('Failed to store chunk in IndexedDB:', e);
            if (e.name === 'QuotaExceededError' || e.code === 22 || e.message.includes('quota')) {
                const formattedError = formatWebRTCError(e);
                receiverStatus.innerHTML = `<div class="status error">${formattedError.message.replace(/\n/g, '<br>')}</div>`;
                transferActive = false;
                return;
            }
        });
    }
    
    // Send ACK every 20th chunk (256KB chunks → ACK per 5MB; reduces round-trip overhead)
    if (chunkIndex % 20 === 0 || chunkIndex === 0) {
        sendChunkAck(chunkIndex);
    }
    
    // Calculate actual received bytes from unique chunks (more accurate)
    const actualReceivedBytes = Array.from(receiverChunkState.receivedChunkMap.values())
        .reduce((sum, chunk) => sum + chunk.length, 0);
    
    // Throttle UI updates to reduce DOM manipulation overhead
    const now = Date.now();
    if (!window.lastReceiverUIUpdate) window.lastReceiverUIUpdate = 0;
    const receiverUIInterval = isSafari ? 500 : 200; // Slower for Safari
    if (now - window.lastReceiverUIUpdate > receiverUIInterval || actualReceivedBytes >= fileMetadata.size) {
        const progress = (actualReceivedBytes / fileMetadata.size) * 100;
        receiverProgressBar.style.width = progress + '%';
        receiverStatus.innerHTML = `
            <div class="status info">
                Downloading: ${(actualReceivedBytes / 1024 / 1024).toFixed(2)} MB / ${(fileMetadata.size / 1024 / 1024).toFixed(2)} MB (${progress.toFixed(1)}%)
            </div>
        `;
        window.lastReceiverUIUpdate = now;
        if (currentReceivingUrl) setFileState(currentReceivingUrl, 'receiving', progress);
    }
    
    // Update totalReceived to match actual received bytes (for consistency)
    totalReceived = actualReceivedBytes;
    
    if (actualReceivedBytes >= fileMetadata.size) {
        completeDownload();
    }
}

// Send ACK for chunk
function sendChunkAck(chunkIndex) {
    if (!peer || !isConnected || peer.destroyed) return;
    
    try {
        const ackMessage = {
            type: 'chunk-ack',
            chunkIndex: chunkIndex
        };
        
        // Use peer._channel if available (SimplePeer internal), otherwise use peer.send
        if (peer._channel && peer._channel.readyState === 'open') {
            peer._channel.send(JSON.stringify(ackMessage));
        } else if (peer.connected && !peer.destroyed) {
            peer.send(JSON.stringify(ackMessage));
        }
    } catch (e) {
        console.error('Failed to send ACK:', e);
    }
}

// Check if we can assemble consecutive chunks
function checkAndAssembleChunks() {
    // This is handled in completeDownload, but we could optimize here
    // For now, we'll just track received chunks
}

function handleReceivedData(data) {
    let buffer;
    if (data instanceof ArrayBuffer) {
        buffer = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
        buffer = data;
    } else {
        buffer = new Uint8Array(data);
    }

    if (!fileMetadata) {
        try {
            const text = typeof data === 'string' ? data : new TextDecoder().decode(buffer);
            const metadata = JSON.parse(text);
            
            if (metadata.type === 'file-metadata') {
                fileMetadata = metadata;
                receivedChunks = [];
                totalReceived = 0;
                receiverChunkState.receivedChunkMap.clear();
                receiverChunkState.expectedChunkIndex = 0;
                currentReceivingUrl = getFileUrlFromName(metadata.name);
                if (currentReceivingUrl) setFileState(currentReceivingUrl, 'receiving', 0);

                // Clear previous chunks from IndexedDB
                if (db) {
                    clearIndexedDB().catch(e => console.warn('Failed to clear IndexedDB:', e));
                }
                
                const cacheInfo = metadata.cacheControl ? 
                    ` (Cache-Control: ${metadata.cacheControl})` : '';
                receiverStatus.innerHTML = `<div class="status info">Receiving: ${metadata.name} (${(metadata.size / 1024 / 1024).toFixed(2)} MB)${cacheInfo} - Using IndexedDB with flow control</div>`;
                return;
            }
        } catch (e) {
            console.warn('Expected metadata but got binary data');
            return;
        }
    } else {
        // Legacy format - handle as before but with ACK
        const chunkIndex = receivedChunks.length;
        receivedChunks.push(null);
        totalReceived += buffer.length;
        
        receiverChunkState.receivedChunkMap.set(chunkIndex, buffer);
        sendChunkAck(chunkIndex);
        
        if (db) {
            storeChunkInDB(chunkIndex, buffer).catch(e => {
                console.error('Failed to store chunk:', e);
                receivedChunks[chunkIndex] = buffer;
            });
        } else {
            receivedChunks[chunkIndex] = buffer;
        }
        
        if (chunkIndex % 10 === 0 || totalReceived >= fileMetadata.size) {
            const progress = (totalReceived / fileMetadata.size) * 100;
            receiverProgressBar.style.width = progress + '%';
            receiverStatus.innerHTML = `
                <div class="status info">
                    Downloading: ${(totalReceived / 1024 / 1024).toFixed(2)} MB / ${(fileMetadata.size / 1024 / 1024).toFixed(2)} MB (${progress.toFixed(1)}%)
                </div>
            `;
            if (currentReceivingUrl) setFileState(currentReceivingUrl, 'receiving', progress);
        }
        
        if (totalReceived >= fileMetadata.size) {
            completeDownload();
        }
    }
}

let _completeDownloadRunning = false;

async function completeDownload() {
    if (!fileMetadata) return;
    if (_completeDownloadRunning) return; // prevent concurrent calls
    _completeDownloadRunning = true;
    transferActive = false; // stop data handler immediately — no more chunks accepted

    receiverStatus.innerHTML = '<div class="status info">Assembling file from IndexedDB...</div>';
    
    let chunks;
    if (db) {
        // Read chunks from IndexedDB, sorted by index
        try {
            chunks = await getAllChunksFromDB();
            console.log(`Retrieved ${chunks.length} chunks from IndexedDB`);
        } catch (e) {
            console.error('Failed to read from IndexedDB, using memory chunks:', e);
            // Use chunk map if available, otherwise fallback to receivedChunks
            if (receiverChunkState.receivedChunkMap.size > 0) {
                const sortedIndices = Array.from(receiverChunkState.receivedChunkMap.keys()).sort((a, b) => a - b);
                chunks = sortedIndices.map(idx => receiverChunkState.receivedChunkMap.get(idx));
            } else {
                chunks = receivedChunks.filter(c => c !== null);
            }
        }
    } else {
        // Use chunk map if available
        if (receiverChunkState.receivedChunkMap.size > 0) {
            const sortedIndices = Array.from(receiverChunkState.receivedChunkMap.keys()).sort((a, b) => a - b);
            chunks = sortedIndices.map(idx => receiverChunkState.receivedChunkMap.get(idx));
        } else {
            chunks = receivedChunks.filter(c => c !== null);
        }
    }
    
    receiverStatus.innerHTML = '<div class="status info">Creating file blob...</div>';
    
    // Combine chunks into single blob
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    let combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }
    
    const blob = new Blob([combined], { type: fileMetadata.mimeType || 'application/octet-stream' });
    
    // Cache the file if headers allow (check if cacheable)
    const cacheable = fileMetadata.cacheControl && 
        (fileMetadata.cacheControl.includes('public') || 
         fileMetadata.cacheControl.includes('max-age') ||
         fileMetadata.cacheControl.includes('immutable'));
    
    if (cacheable && db) {
        try {
            await cacheFileInDB(fileMetadata, combined);
            console.log('File cached successfully');
            // Store cached file name in localStorage for persistence
            localStorage.setItem('p2p_cached_file', fileMetadata.name);
            
            // Clear combined array from memory after caching (file is now in IndexedDB)
            // Keep reference only if needed for immediate sharing
            if (!window.cachedFileData) {
                // Free memory - file is in IndexedDB, can be loaded when needed
                combined = null;
            }
        } catch (e) {
            console.warn('Failed to cache file:', e);
        }
    } else {
        // Not cacheable - clear combined array to free memory
        combined = null;
    }
    
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
    
    let statusMsg = `<div class="status success">✓ File received! (${(fileMetadata.size / 1024 / 1024).toFixed(2)} MB)`;
    if (cacheable) {
        statusMsg += '<br>✓ File cached - you can now share it to other receivers';
    }
    statusMsg += '</div>';
    receiverStatus.innerHTML = statusMsg;
    receiverStatus.appendChild(a);

    if (currentReceivingUrl) setFileState(currentReceivingUrl, 'complete');

    const isVideo = blob.type.startsWith('video/') || isVideoUrl(fileMetadata.name);
    if (isVideo) {
        showVideoPlayer(url, fileMetadata.name);
        // Don't revoke: the video player holds a live reference to this blob URL
    }

    // Automatically become a sender after receiving the file
    // This allows receivers to share the file to other receivers (mesh network)
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Register as sender so other receivers can connect to us
        ws.send(JSON.stringify({ type: 'register', role: 'sender' }));
        console.log('Receiver completed download - now registered as sender');
        
        // Store role and cached file name in localStorage for persistence
        localStorage.setItem('p2p_role', 'sender');
        localStorage.setItem('p2p_cached_file', fileMetadata.name);
        
        // Update UI to show we're now also a sender
        const senderInfo = document.createElement('div');
        senderInfo.className = 'status success';
        senderInfo.style.marginTop = '10px';
        senderInfo.innerHTML = '✓ You are now a sender! Other receivers can connect to you.';
        receiverStatus.appendChild(senderInfo);
        
        // Switch role to sender (but keep receiver UI visible)
        currentRole = 'sender';
        updateRoleUI('sender');
        
        // Store the file metadata for sharing (but don't keep data in memory)
        window.cachedFileMetadata = fileMetadata;
        // Don't store combined in memory - load from IndexedDB when needed
        window.cachedFileData = null;
        
        // Don't create peer proactively - wait for receiver-initiated connections
        // Receivers will initiate connections when they detect an available sender
        // The handleOffer function will handle receiver-initiated offers and auto-share
    }
    
    // Add button to share cached file if cacheable (manual trigger)
    if (cacheable) {
        const shareCachedBtn = document.createElement('button');
        shareCachedBtn.textContent = 'Share Cached File Now';
        shareCachedBtn.style.marginTop = '10px';
        shareCachedBtn.style.padding = '12px 24px';
        shareCachedBtn.style.background = 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)';
        shareCachedBtn.style.color = 'white';
        shareCachedBtn.style.border = 'none';
        shareCachedBtn.style.borderRadius = '8px';
        shareCachedBtn.style.cursor = 'pointer';
        shareCachedBtn.onclick = () => {
            shareCachedFile(fileMetadata.name);
        };
        receiverStatus.appendChild(shareCachedBtn);
    }
    
    if (!isVideo) {
        // Auto-trigger save dialog for non-video files; revoke the blob URL after use
        setTimeout(() => {
            a.click();
            URL.revokeObjectURL(url);
        }, 500);
    }
    
    // Don't clean up IndexedDB chunks if file is cacheable (keep for sharing)
    if (!cacheable && db) {
        clearIndexedDB().catch(e => console.warn('Failed to clear IndexedDB:', e));
    }
    
    receiverProgress.style.display = 'none';
    stopReceiverBtn.style.display = 'none';
    transferActive = false;
    _completeDownloadRunning = false;

    // Clear memory chunks
    receivedChunks = [];
    receiverChunkState.receivedChunkMap.clear();
}

// Initialize IndexedDB for storing file chunks
async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('p2p-file-transfer', 4); // v4: fileChunks keyed by chunkIndex for upsert

        request.onerror = () => {
            console.error('IndexedDB error:', request.error);
            reject(request.error);
        };

        request.onsuccess = () => {
            db = request.result;
            console.log('IndexedDB initialized');
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            // Create object store for file chunks — keyed by chunkIndex so put() upserts duplicates
            if (db.objectStoreNames.contains('fileChunks')) {
                db.deleteObjectStore('fileChunks'); // drop old auto-increment store
            }
            db.createObjectStore('fileChunks', { keyPath: 'chunkIndex' });
            // Create object store for cached files
            if (!db.objectStoreNames.contains('cachedFiles')) {
                const cachedStore = db.createObjectStore('cachedFiles', { keyPath: 'id', autoIncrement: true });
                cachedStore.createIndex('fileName', 'fileName', { unique: false });
                cachedStore.createIndex('fileSize', 'fileSize', { unique: false });
                cachedStore.createIndex('etag', 'etag', { unique: false });
            }
            // Create object store for transfer progress (resume functionality)
            if (!db.objectStoreNames.contains('transferProgress')) {
                const progressStore = db.createObjectStore('transferProgress', { keyPath: 'fileUrl' });
                progressStore.createIndex('fileName', 'fileName', { unique: false });
            }
        };
    });
}

// Store chunk in IndexedDB
async function storeChunkInDB(chunkIndex, chunkData) {
    if (!db) {
        await initIndexedDB();
    }

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['fileChunks'], 'readwrite');
        const store = transaction.objectStore('fileChunks');
        // Use put (upsert) keyed by chunkIndex so retried duplicates overwrite
        const request = store.put({
            chunkIndex: chunkIndex,
            data: chunkData,
            timestamp: Date.now()
        });

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Get all chunks from IndexedDB
async function getAllChunksFromDB() {
    if (!db) return [];

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['fileChunks'], 'readonly');
        const store = transaction.objectStore('fileChunks');
        // chunkIndex is now the keyPath — getAll returns records in key order
        const request = store.getAll();

        request.onsuccess = () => {
            resolve(request.result.map(c => c.data));
        };

        request.onerror = () => reject(request.error);
    });
}

// Clear all chunks from IndexedDB
async function clearIndexedDB() {
    if (!db) return;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['fileChunks'], 'readwrite');
        const store = transaction.objectStore('fileChunks');
        const request = store.clear();
        
        request.onsuccess = () => {
            console.log('IndexedDB cleared');
            resolve();
        };
        
        request.onerror = () => reject(request.error);
    });
}

// Cache complete file in IndexedDB
async function cacheFileInDB(metadata, fileData) {
    if (!db) {
        await initIndexedDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['cachedFiles'], 'readwrite');
        const store = transaction.objectStore('cachedFiles');
        const request = store.add({
            fileName: metadata.name,
            fileSize: metadata.size,
            mimeType: metadata.mimeType,
            cacheControl: metadata.cacheControl || '',
            etag: metadata.etag || '',
            data: fileData,
            timestamp: Date.now()
        });
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Get cached file from IndexedDB
async function getCachedFile(fileName) {
    if (!db) return null;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['cachedFiles'], 'readonly');
        const store = transaction.objectStore('cachedFiles');
        const index = store.index('fileName');
        const request = index.getAll(fileName);
        
        request.onsuccess = () => {
            const result = request.result;
            if (result && result.length > 0) {
                // Return most recent cached file
                const sorted = result.sort((a, b) => b.timestamp - a.timestamp);
                resolve(sorted[0]);
            } else {
                resolve(null);
            }
        };
        
        request.onerror = () => reject(request.error);
    });
}

// Save transfer progress to IndexedDB (for resume functionality)
async function saveTransferProgress(fileUrl, lastChunkIndex, isComplete = false) {
    if (!db) return;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['transferProgress'], 'readwrite');
        const store = transaction.objectStore('transferProgress');
        
        // Convert Set to Array for storage
        const acknowledgedArray = Array.from(senderChunkState.acknowledgedChunks);
        
        const progressData = {
            fileUrl: fileUrl,
            fileName: window.transferDiagnostics?.fileName || 'unknown',
            fileSize: window.transferDiagnostics?.fileSize || 0,
            lastChunkIndex: lastChunkIndex,
            acknowledgedChunks: acknowledgedArray,
            isComplete: isComplete,
            timestamp: Date.now()
        };
        
        const request = store.put(progressData);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Get transfer progress from IndexedDB
async function getTransferProgress(fileUrl) {
    if (!db) return null;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['transferProgress'], 'readonly');
        const store = transaction.objectStore('transferProgress');
        const request = store.get(fileUrl);
        
        request.onsuccess = () => {
            const result = request.result;
            if (result && !result.isComplete) {
                // Convert Array back to Set
                result.acknowledgedChunks = new Set(result.acknowledgedChunks);
                resolve(result);
            } else {
                resolve(null);
            }
        };
        
        request.onerror = () => reject(request.error);
    });
}

// Clear transfer progress (after successful completion)
async function clearTransferProgress(fileUrl) {
    if (!db) return;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['transferProgress'], 'readwrite');
        const store = transaction.objectStore('transferProgress');
        const request = store.delete(fileUrl);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Share cached file
async function shareCachedFile(fileName) {
    if (currentRole !== 'sender') {
        console.warn('Cannot share: not a sender');
        return;
    }
    
    const cachedFile = await getCachedFile(fileName);
    if (!cachedFile) {
        shareStatus.innerHTML = '<div class="status error">Cached file not found</div>';
        return;
    }
    
    transferActive = true;
    metadataSent = false;

    // Mark sender as busy
    sendSenderStatusUpdate('busy', fileName);

    // Reset chunking state
    senderChunkState.nextChunkIndex = 0;
    senderChunkState.pendingChunks.clear();
    senderChunkState.acknowledgedChunks.clear();
    
    // Wait for connection if peer already exists (receiver-initiated)
    // Don't create peer proactively - wait for receiver to initiate connection
    if (!peer || !isConnected) {
        console.log('No peer connection yet - waiting for receiver to initiate connection');
        shareStatus.innerHTML = '<div class="status info">Waiting for receiver to connect...</div>';
        
        // Wait for receiver-initiated connection (peer will be created in handleOffer)
        let attempts = 0;
        const maxAttempts = 300; // 30 seconds max wait
        await new Promise((resolve) => {
            const checkConnected = setInterval(() => {
                attempts++;
                if (isConnected && peer && peer.connected) {
                    clearInterval(checkConnected);
                    setTimeout(() => resolve(), 500);
                } else if (attempts >= maxAttempts) {
                    clearInterval(checkConnected);
                    console.warn('Timeout waiting for receiver-initiated connection');
                    resolve(); // Resolve anyway to continue
                }
            }, 100);
        });
    }
    
    if (!peer || !isConnected || !peer.connected) {
        shareStatus.innerHTML = '<div class="status error">Failed to establish connection</div>';
        transferActive = false;
        return;
    }
    
    // Send metadata
    const metadata = {
        type: 'file-metadata',
        name: cachedFile.fileName,
        size: cachedFile.fileSize,
        mimeType: cachedFile.mimeType,
        chunkSize: senderChunkState.chunkSize,
        cacheControl: cachedFile.cacheControl,
        etag: cachedFile.etag
    };
    
    try {
        if (senderChunkState.dataChannel && senderChunkState.dataChannel.readyState === 'open') {
            senderChunkState.dataChannel.send(JSON.stringify(metadata));
        } else if (peer && peer.connected && !peer.destroyed) {
            peer.send(JSON.stringify(metadata));
        } else {
            shareStatus.innerHTML = '<div class="status error">Cannot send metadata: peer not ready</div>';
            transferActive = false;
            return;
        }
        metadataSent = true;

        // Send file data in chunks (process in batches to avoid blocking)
        const fileData = cachedFile.data;
        const chunkSize = senderChunkState.chunkSize;
        let offset = 0;
        senderChunkState.nextChunkIndex = 0;
        let lastUIUpdate = 0;
        
        shareStatus.innerHTML = '<div class="status info">Sharing cached file...</div>';
        
        // Process chunks in batches with yield to prevent blocking
        while (offset < fileData.length && transferActive) {
            // Process up to 10 chunks before yielding
            for (let i = 0; i < 10 && offset < fileData.length && transferActive; i++) {
                const chunk = fileData.slice(offset, Math.min(offset + chunkSize, fileData.length));
                await sendChunkWithFlowControl(chunk, senderChunkState.nextChunkIndex, fileData.length, offset + chunk.length);
                senderChunkState.nextChunkIndex++;
                offset += chunkSize;
            }
            
            // Yield to browser to prevent blocking
            await new Promise(resolve => setTimeout(resolve, 0));
            
            // Periodic cleanup
            if (senderChunkState.nextChunkIndex % 100 === 0) {
                cleanupAcknowledgedChunks();
            }
        }
        
        await waitForAllChunksAcknowledged();
        cleanupMemoryAfterTransfer();
        
        // Mark sender as available after successful transfer
        sendSenderStatusUpdate('available');
        
        shareStatus.innerHTML = '<div class="status success">✓ Cached file shared successfully!</div>';
        transferActive = false;
        
        // Clear cached file data from memory after sharing
        cachedFile.data = null;
    } catch (e) {
        console.error('Failed to share cached file:', e);
        shareStatus.innerHTML = `<div class="status error">Error sharing cached file: ${e.message}</div>`;
        
        // Mark sender as available after error
        sendSenderStatusUpdate('available');
        
        transferActive = false;
    }
}

// Auto-connect on page load
window.addEventListener('load', async () => {
    // Initialize file selection checkboxes (receiver)
    initFileSelection();
    // Initialize sender file selection checkboxes
    initSenderFileSelection();
    
    // Initialize IndexedDB
    try {
        await initIndexedDB();
    } catch (e) {
        console.warn('IndexedDB initialization failed, will use memory storage:', e);
    }
    
    // Check if we have a stored role and restore UI
    const storedRole = localStorage.getItem('p2p_role');
    if (storedRole) {
        currentRole = storedRole;
        updateRoleUI(storedRole);
        
        if (storedRole === 'sender') {
            const cachedFileName = localStorage.getItem('p2p_cached_file');
            if (cachedFileName) {
                shareStatus.innerHTML = `<div class="status info">Restoring sender session... Ready to share: ${cachedFileName}</div>`;
            }
        } else if (storedRole === 'receiver') {
            receiverStatus.innerHTML = '<div class="status info">Restoring receiver session...</div>';
        }
    }
    
    // Connect to signaling server (will restore role if stored)
    connectSignaling();
    
    // Handle page unload — destroy WebRTC peer and close WebSocket so the
    // server immediately removes this client from the sender/receiver lists
    // and broadcasts the updated network status to remaining peers.
    window.addEventListener('beforeunload', () => {
        if (peer && !peer.destroyed) {
            try { peer.destroy(); } catch (e) {}
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.close(1000, 'Page closing'); } catch (e) {}
        }
    });
});

