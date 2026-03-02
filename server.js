const express = require('express');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const { ExpressPeerServer } = require('peer');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Local-network enforcement for WebRTC ICE candidates
//
// WHY: The signaling server (HTTP + WebSocket) is reachable from the internet
// so we cannot restrict connections by source IP.  Instead we enforce
// local-only P2P at the ICE candidate layer:
//   • External STUN servers are removed from the client ICE config so browsers
//     never discover their public/NAT IP and cannot advertise it as a candidate.
//   • This relay filter is a second line of defence: even if a client somehow
//     produces a non-private candidate, the server silently drops it instead of
//     forwarding it to the remote peer.
//
// Allowed address families:
//   IPv4 – loopback (127/8), RFC-1918 (10/8, 172.16/12, 192.168/16),
//          link-local (169.254/16)
//   IPv6 – loopback (::1), link-local (fe80::/10), ULA (fd00::/8)
// ---------------------------------------------------------------------------

/**
 * Returns true when `ip` belongs to a private / local address range.
 * @param {string} ip
 */
function isLocalIP(ip) {
  if (!ip) return false;
  // IPv4 loopback
  if (/^127\./.test(ip)) return true;
  // RFC-1918
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // IPv4 link-local (APIPA)
  if (/^169\.254\./.test(ip)) return true;
  // IPv6 loopback
  if (/^::1$/.test(ip)) return true;
  // IPv6 link-local
  if (/^fe80:/i.test(ip)) return true;
  // IPv6 ULA (unique local)
  if (/^fd[0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}

/**
 * Parses an ICE candidate string and returns the IP address field, or null.
 * Candidate format (RFC 5245):
 *   candidate:<foundation> <component> <transport> <priority> <ip> <port> typ <type> …
 * The IP is always at index 4 of the space-delimited string.
 * @param {string} candidateStr  e.g. "candidate:0 1 udp 2122194687 192.168.1.5 55123 typ host …"
 * @returns {string|null}
 */
function extractCandidateIP(candidateStr) {
  if (!candidateStr || typeof candidateStr !== 'string') return null;
  const parts = candidateStr.split(' ');
  return parts.length > 4 ? parts[4] : null;
}

// Body parser middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust the first proxy hop (Traefik) so req.ip reflects the real client IP
// when the app runs behind Cloudflare Tunnel → Traefik → container.
app.set('trust proxy', 1);

// Health-check endpoint used by Coolify / Docker HEALTHCHECK.
// Returns 200 immediately; no auth required.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Serve the main app route first (before static files)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/sender', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sender.html'));
});

app.get('/receiver', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'receiver.html'));
});

app.get('/peerjs-poc', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app-peerjs.html'));
});

// WebSocket server status endpoint
app.get('/api/ws-status', (req, res) => {
  const wss = global.wss;
  if (!wss) {
    return res.json({
      websocket: {
        connected: 0,
        activeSenders: 0,
        activeReceivers: 0,
        totalSenders: 0,
        totalReceivers: 0,
        status: 'not initialized'
      },
      senders: [],
      peerServer: {
        enabled: true,
        path: '/peerjs',
        port: PORT
      }
    });
  }
  
  const activeSenders = clients.senders.filter(ws => ws.readyState === WebSocket.OPEN).length;
  const activeReceivers = clients.receivers.filter(ws => ws.readyState === WebSocket.OPEN).length;
  
  const senderDetails = clients.senders
    .map((ws, index) => {
      if (ws.readyState === WebSocket.OPEN) {
        const status = senderStatus.get(ws) || { status: 'available' };
        return {
          id: index,
          status: status.status,
          fileName: status.fileName || null
        };
      }
      return null;
    })
    .filter(Boolean);
  
  res.json({
    websocket: {
      connected: wss.clients.size,
      activeSenders: activeSenders,
      activeReceivers: activeReceivers,
      totalSenders: clients.senders.length,
      totalReceivers: clients.receivers.length,
      status: 'running'
    },
    senders: senderDetails,
    peerServer: {
      enabled: true,
      path: '/peerjs',
      port: PORT
    }
  });
});

// Serve generated test file
app.get('/test-file-200mb.bin', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'test-file-200mb.bin');
  
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Test file not found. Run: node generate-test-file.js' });
  }
  
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  
  // Set headers for file download
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', fileSize);
  res.setHeader('Content-Disposition', 'attachment; filename="test-file-200mb.bin"');
  res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
  
  // Stream the file
  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);
  
  fileStream.on('error', (err) => {
    console.error('Error streaming test file:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error streaming file' });
    }
  });
});

// Proxy endpoint to fetch files server-side (bypasses CORS)
app.get('/api/fetch-file', async (req, res) => {
  const fileUrl = req.query.url;
  
  if (!fileUrl) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const url = new URL(fileUrl);
    const protocol = url.protocol === 'https:' ? https : http;
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    
    protocol.get(fileUrl, (proxyRes) => {
      // Forward status code
      res.status(proxyRes.statusCode);
      
      // Forward headers
      const headersToForward = ['content-type', 'content-length', 'content-disposition'];
      headersToForward.forEach(header => {
        if (proxyRes.headers[header]) {
          res.setHeader(header, proxyRes.headers[header]);
        }
      });
      
      // Pipe the response
      proxyRes.pipe(res);
      
      proxyRes.on('error', (err) => {
        console.error('Proxy error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Proxy error: ' + err.message });
        }
      });
    }).on('error', (err) => {
      console.error('Request error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Request error: ' + err.message });
      }
    });
  } catch (error) {
    console.error('Invalid URL:', error);
    res.status(400).json({ error: 'Invalid URL: ' + error.message });
  }
});

// Body parser middleware (but skip for WebSocket upgrades)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (but index.html won't override the route above)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Sender page: http://localhost:${PORT}/sender`);
  console.log(`Receiver page: http://localhost:${PORT}/receiver`);
  console.log(`PeerJS POC: http://localhost:${PORT}/peerjs-poc`);
  
  // WebSocket server for WebRTC signaling.
  // Use noServer:true so this server never registers its own 'upgrade' listener.
  // Without this, PeerJS's ws.Server (created later) would also receive every
  // upgrade event and call socket.destroy() for paths it doesn't own, killing
  // already-established WebSocket connections with a 1006 / RSV1 error.
  console.log('Initializing WebSocket server...');
  const wss = new WebSocket.Server({
    noServer: true,
    perMessageDeflate: false,
    clientTracking: true
  });

  wss.on('error', (error) => {
    console.error('✗ WebSocket server error:', error);
  });

  // Make wss available globally for status endpoint and other handlers
  global.wss = wss;

  // Setup WebSocket connection handlers
  setupWebSocketHandlers(wss);

  // Setup PeerServer; capture its internal ws.Server via createWebSocketServer
  // so we can route upgrade requests to it manually.
  let peerWss;
  setupPeerServer(server, (capturedWss) => { peerWss = capturedWss; });

  // Single upgrade router – runs before any ws.Server auto-handlers.
  // Routes /peerjs connections to PeerJS, everything else to our wss.
  server.on('upgrade', (request, socket, head) => {
    const url = request.url || '/';
    if (url.startsWith('/peerjs')) {
      console.log(`WebSocket upgrade for PeerJS: ${url}`);
      if (peerWss) {
        peerWss.handleUpgrade(request, socket, head, (ws) => {
          peerWss.emit('connection', ws, request);
        });
      } else {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
      }
    } else if (url.startsWith('/api/') || url.startsWith('/test-file')) {
      console.log(`WebSocket upgrade rejected for path: ${url}`);
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
    } else {
      console.log(`WebSocket upgrade allowed for path: ${url}`);
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });
});

// WebSocket client tracking (shared across handlers)
const clients = {
  senders: [], // Support multiple senders (receivers can become senders)
  receivers: [] // Support multiple receivers (up to 30)
};

// Track sender status: Map<WebSocket, {status: 'available'|'busy', fileName?: string}>
const senderStatus = new Map();

// Broadcast network status to all clients
function broadcastNetworkStatus() {
  const availableSenders = [];
  const busySenders = [];
  
  clients.senders.forEach((senderWs, index) => {
    if (senderWs.readyState === WebSocket.OPEN) {
      const status = senderStatus.get(senderWs) || { status: 'available' };
      const senderInfo = {
        id: index,
        status: status.status,
        fileName: status.fileName || null
      };
      
      if (status.status === 'busy') {
        busySenders.push(senderInfo);
      } else {
        availableSenders.push(senderInfo);
      }
    }
  });
  
  const networkStatus = {
    type: 'network-status',
    availableSenders: availableSenders.length,
    busySenders: busySenders.length,
    totalSenders: clients.senders.length,
    totalReceivers: clients.receivers.length,
    senders: {
      available: availableSenders,
      busy: busySenders
    }
  };
  
  // Broadcast to all clients
  const statusMessage = JSON.stringify(networkStatus);
  [...clients.senders, ...clients.receivers].forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(statusMessage);
    }
  });
  
  console.log(`Network status: ${availableSenders.length} available, ${busySenders.length} busy senders, ${clients.receivers.length} receivers`);
}

// Setup WebSocket connection handlers
function setupWebSocketHandlers(wss) {
  wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
  const clientPort = req.socket.remotePort;
  console.log(`✓ New WebSocket connection from ${clientIP}:${clientPort}`);
  
  // Set up ping/pong to keep connection alive
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      // Handle different message types (Buffer, ArrayBuffer, string)
      let messageStr;
      if (Buffer.isBuffer(message)) {
        messageStr = message.toString('utf8');
      } else if (message instanceof ArrayBuffer) {
        messageStr = Buffer.from(message).toString('utf8');
      } else if (typeof message === 'string') {
        messageStr = message;
      } else {
        console.error('Unexpected message type:', typeof message, message.constructor.name);
        return;
      }
      
      const data = JSON.parse(messageStr);
      console.log('Received message:', data.type);

      if (data.type === 'register') {
        // Check if client wants to auto-detect role
        if (data.role === 'auto') {
          if (clients.senders.length > 0) {
            // Sender exists, become receiver
            if (clients.receivers.length < 30) {
              clients.receivers.push(ws);
              ws.send(JSON.stringify({ type: 'registered', role: 'receiver', senderExists: true, receiverIndex: clients.receivers.length - 1 }));
              console.log(`Auto-registered as receiver ${clients.receivers.length - 1} (${clients.senders.length} sender(s) exist, total receivers: ${clients.receivers.length})`);
              broadcastNetworkStatus();
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'Maximum receivers (30) reached' }));
              console.log('Rejected receiver registration: maximum reached');
            }
          } else {
            // No sender, become sender
            clients.senders.push(ws);
            senderStatus.set(ws, { status: 'available' });
            ws.send(JSON.stringify({ type: 'registered', role: 'sender', senderExists: false }));
            console.log(`Auto-registered as sender (total senders: ${clients.senders.length})`);
            broadcastNetworkStatus();
          }
        } else if (data.role === 'sender') {
          // Check if already registered as receiver, remove from receivers first
          const receiverIndex = clients.receivers.indexOf(ws);
          if (receiverIndex !== -1) {
            clients.receivers.splice(receiverIndex, 1);
            console.log(`Receiver ${receiverIndex} switched to sender`);
          }
          // Add as sender (allow multiple senders)
          if (clients.senders.indexOf(ws) === -1) {
            clients.senders.push(ws);
            senderStatus.set(ws, { status: 'available' });
          }
          ws.send(JSON.stringify({ type: 'registered', role: 'sender', senderExists: clients.senders.length > 1 }));
          console.log(`Sender registered (total senders: ${clients.senders.length})`);
          broadcastNetworkStatus();
        } else if (data.role === 'receiver') {
          if (clients.receivers.length < 30) {
            clients.receivers.push(ws);
            ws.send(JSON.stringify({ type: 'registered', role: 'receiver', senderExists: clients.senders.length > 0, receiverIndex: clients.receivers.length - 1 }));
            console.log(`Receiver registered (${clients.senders.length} sender(s), total receivers: ${clients.receivers.length})`);
            broadcastNetworkStatus();
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Maximum receivers (30) reached' }));
            console.log('Rejected receiver registration: maximum reached');
          }
        }
      } else if (data.type === 'sender-status-update') {
        // Update sender status (available/busy)
        if (clients.senders.includes(ws)) {
          senderStatus.set(ws, {
            status: data.status, // 'available' or 'busy'
            fileName: data.fileName || null
          });
          broadcastNetworkStatus();
        }
      } else if (data.type === 'check-sender') {
        // Check if sender exists
        ws.send(JSON.stringify({ type: 'sender-status', exists: clients.senders.length > 0 }));
      } else if (data.type === 'offer') {
        // Handle offers from both senders and receivers
        if (data.role === 'receiver') {
          // Receiver-initiated offer: forward to senders
          const offerMessage = JSON.stringify({ type: 'offer', offer: data.offer, role: 'receiver' });
          const availableSender = clients.senders.find(s => s.readyState === WebSocket.OPEN);
          if (availableSender) {
            availableSender.send(offerMessage);
            console.log('✓ Forwarded receiver-initiated offer to sender');
          } else {
            console.warn('⚠️  WARNING: Receiver sent offer but no senders are available');
          }
        } else {
          // Sender-initiated offer: forward to all receivers
          if (clients.receivers.length > 0) {
            const offerMessage = JSON.stringify({ type: 'offer', offer: data.offer });
            let forwardedCount = 0;
            clients.receivers.forEach((receiver, index) => {
              if (receiver.readyState === WebSocket.OPEN) {
                receiver.send(offerMessage);
                forwardedCount++;
              } else {
                console.warn(`Receiver ${index} not ready (state: ${receiver.readyState})`);
              }
            });
            console.log(`Forwarded offer from sender to ${forwardedCount}/${clients.receivers.length} receiver(s)`);
            if (forwardedCount === 0) {
              console.warn('⚠️  WARNING: Offer sent but no receivers are ready to receive it');
            }
          } else {
            console.warn('⚠️  WARNING: Sender sent offer but no receivers are registered');
          }
        }
      } else if (data.type === 'answer') {
        // Forward answer based on role
        // If sender sends answer (receiver-initiated connection), forward to receivers
        // If receiver sends answer (sender-initiated connection), forward to senders
        if (data.role === 'sender') {
          // Sender responding to receiver-initiated offer: forward to receivers
          if (clients.receivers.length > 0) {
            const answerMessage = JSON.stringify({ type: 'answer', answer: data.answer });
            let forwardedCount = 0;
            clients.receivers.forEach((receiver, index) => {
              if (receiver.readyState === WebSocket.OPEN) {
                receiver.send(answerMessage);
                forwardedCount++;
              }
            });
            console.log(`✓ Forwarded sender answer to ${forwardedCount} receiver(s)`);
          } else {
            console.warn('⚠️  WARNING: Sender sent answer but no receivers are available');
          }
        } else {
          // Receiver responding to sender-initiated offer: forward to senders
          const availableSender = clients.senders.find(s => s.readyState === WebSocket.OPEN);
          if (availableSender) {
            availableSender.send(JSON.stringify({ type: 'answer', answer: data.answer }));
            console.log('✓ Forwarded receiver answer to sender');
          } else {
            console.warn('⚠️  WARNING: Receiver sent answer but no senders are available');
          }
        }
      } else if (data.type === 'ice-candidate') {
        // Forward ICE candidates – local-network filter applied before relaying.
        // data.candidate is the SimplePeer signal object:
        //   { type: 'candidate', candidate: { candidate: '<SDP string>', sdpMid, sdpMLineIndex } }
        // The actual SDP candidate string lives at data.candidate?.candidate?.candidate.
        const sdpCandidateStr = data.candidate?.candidate?.candidate ?? '';
        const candidateIP = extractCandidateIP(sdpCandidateStr);
        if (sdpCandidateStr && !isLocalIP(candidateIP)) {
          // Drop candidates that advertise a public/internet-routable IP.
          // This prevents WebRTC from negotiating a route outside the local network
          // even when the signaling server itself is reachable from the internet.
          console.warn(`⚠️  Dropped non-local ICE candidate (ip=${candidateIP}, role=${data.role})`);
        } else if (data.role === 'sender') {
          // Forward sender's ICE candidates to all receivers
          const candidateMessage = JSON.stringify({ type: 'ice-candidate', candidate: data.candidate });
          let forwardedCount = 0;
          clients.receivers.forEach((receiver, index) => {
            if (receiver.readyState === WebSocket.OPEN) {
              receiver.send(candidateMessage);
              forwardedCount++;
            }
          });
          if (forwardedCount > 0) {
            console.log(`Forwarded sender ICE candidate (ip=${candidateIP}) to ${forwardedCount} receiver(s)`);
          } else {
            console.warn('⚠️  WARNING: Sender ICE candidate not forwarded (no ready receivers)');
          }
        } else if (data.role === 'receiver') {
          // Forward receiver's ICE candidates to first available sender
          const availableSender = clients.senders.find(s => s.readyState === WebSocket.OPEN);
          if (availableSender) {
            availableSender.send(JSON.stringify({ type: 'ice-candidate', candidate: data.candidate }));
            console.log(`✓ Forwarded receiver ICE candidate (ip=${candidateIP}) to sender`);
          } else {
            console.warn('⚠️  WARNING: Receiver ICE candidate not forwarded (no available sender)');
          }
        }
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  ws.on('error', (error) => {
    console.error(`✗ WebSocket error from ${clientIP}:${clientPort}:`, error.message || error);
  });

  ws.on('close', (code, reason) => {
    console.log(`WebSocket connection closed (code: ${code}, reason: ${reason || 'none'})`);
    // Remove from both arrays (client might be in both if they switched roles)
    const senderIndex = clients.senders.indexOf(ws);
    if (senderIndex !== -1) {
      clients.senders.splice(senderIndex, 1);
      senderStatus.delete(ws);
      console.log(`✗ Sender ${senderIndex} disconnected (${clients.senders.length} sender(s) remaining)`);
      if (clients.senders.length === 0) {
        console.warn('⚠️  WARNING: No senders remaining - receivers should auto-promote');
      }
    }
    const receiverIndex = clients.receivers.indexOf(ws);
    if (receiverIndex !== -1) {
      clients.receivers.splice(receiverIndex, 1);
      console.log(`✗ Receiver ${receiverIndex} disconnected (${clients.receivers.length} receivers remaining)`);
    }
    // Broadcast updated network status
    broadcastNetworkStatus();
    // Note: Client can reconnect and restore their role from localStorage
  });
  }); // end wss.on('connection')

  // Ping/pong interval — runs once, not per-connection.
  // Multiple intervals stacking up per connection would race and falsely
  // terminate live connections before they can respond to a ping.
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        console.log('Terminating dead WebSocket connection');
        return ws.terminate();
      }
      ws.isAlive = false;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      } catch (e) {
        console.warn('Error pinging WebSocket:', e.message);
      }
    });
  }, 30000);

  global.pingInterval = pingInterval;

  process.on('SIGTERM', () => {
    clearInterval(pingInterval);
    wss.close();
  });

  process.on('SIGINT', () => {
    clearInterval(pingInterval);
    wss.close();
    process.exit(0);
  });
}

// Setup PeerServer for PeerJS signaling (called after HTTP server starts)
// onPeerWssCreated receives the internal ws.Server so the upgrade router can
// forward /peerjs connections to it without a second competing upgrade listener.
function setupPeerServer(server, onPeerWssCreated) {
  const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/peerjs',
    allow_discovery: true,
    createWebSocketServer: (options) => {
      const peerWss = new WebSocket.Server({ noServer: true });
      if (onPeerWssCreated) onPeerWssCreated(peerWss);
      return peerWss;
    }
  });

  app.use('/peerjs', peerServer);

  peerServer.on('connection', (client) => {
    console.log(`PeerJS peer connected: ${client.getId()}`);
  });

  peerServer.on('disconnect', (client) => {
    console.log(`PeerJS peer disconnected: ${client.getId()}`);
  });

  console.log(`PeerServer ready at http://localhost:${PORT}/peerjs`);
}

