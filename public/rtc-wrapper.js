/**
 * RTCMultiConnection Wrapper
 * Bridges our custom WebSocket signaling with RTCMultiConnection's peer management
 * 
 * This allows us to:
 * - Use RTCMultiConnection for peer connection management
 * - Keep our custom WebSocket signaling server
 * - Maintain our custom chunking protocol
 */

class RTCMultiConnectionWrapper {
    constructor(signalingWs, role = 'sender') {
        this.signalingWs = signalingWs;
        this.role = role;
        this.connection = null;
        this.dataChannel = null;
        this.isConnected = false;
        this.onConnectCallback = null;
        this.onDataCallback = null;
        this.onErrorCallback = null;
        this.onCloseCallback = null;
        
        // Check if RTCMultiConnection is available
        if (typeof RTCMultiConnection === 'undefined') {
            console.warn('RTCMultiConnection not loaded, falling back to SimplePeer');
            return null;
        }
        
        this.init();
    }
    
    init() {
        // Create RTCMultiConnection instance
        this.connection = new RTCMultiConnection();
        
        // Configure for file sharing (data channels only)
        this.connection.session = {
            data: true,  // Enable data channels
            audio: false,
            video: false,
            screen: false
        };
        
        // Use our custom signaling
        this.connection.socketURL = null; // We'll handle signaling manually
        
        // Set up event handlers
        this.connection.onopen = () => {
            console.log('RTCMultiConnection opened');
        };
        
        this.connection.onstream = (event) => {
            // Not used for data-only connections
        };
        
        this.connection.onstreamended = (event) => {
            console.log('Stream ended');
        };
        
        this.connection.onleave = (event) => {
            console.log('Peer left');
            this.isConnected = false;
            if (this.onCloseCallback) {
                this.onCloseCallback();
            }
        };
        
        // Handle data channel
        this.connection.ondata = (event) => {
            if (event.dataChannel) {
                this.dataChannel = event.dataChannel;
                this.setupDataChannel();
            }
        };
        
        // Handle connection established
        this.connection.onconnectionstatechange = (state) => {
            console.log('Connection state:', state);
            if (state === 'connected' && !this.isConnected) {
                this.isConnected = true;
                // Get data channel
                const channels = this.connection.getAllDataChannels();
                if (channels && channels.length > 0) {
                    this.dataChannel = channels[0];
                    this.setupDataChannel();
                }
                if (this.onConnectCallback) {
                    this.onConnectCallback();
                }
            }
        };
        
        // Error handling
        this.connection.onerror = (error) => {
            console.error('RTCMultiConnection error:', error);
            if (this.onErrorCallback) {
                this.onErrorCallback(error);
            }
        };
    }
    
    setupDataChannel() {
        if (!this.dataChannel) return;
        
        this.dataChannel.onopen = () => {
            console.log('Data channel opened');
            this.isConnected = true;
            if (this.onConnectCallback) {
                this.onConnectCallback();
            }
        };
        
        this.dataChannel.onmessage = (event) => {
            if (this.onDataCallback) {
                this.onDataCallback(event.data);
            }
        };
        
        this.dataChannel.onerror = (error) => {
            console.error('Data channel error:', error);
            if (this.onErrorCallback) {
                this.onErrorCallback(error);
            }
        };
        
        this.dataChannel.onclose = () => {
            console.log('Data channel closed');
            this.isConnected = false;
            if (this.onCloseCallback) {
                this.onCloseCallback();
            }
        };
    }
    
    // Create connection as initiator (sender or receiver-initiated)
    connect(roomId = 'file-sharing-room') {
        if (!this.connection) {
            console.warn('RTCMultiConnection not available');
            return false;
        }
        
        // Bridge our WebSocket signaling with RTCMultiConnection
        // We'll intercept RTCMultiConnection's signaling and route through our WebSocket
        this.bridgeSignaling(roomId);
        
        if (this.role === 'sender') {
            // Sender creates room
            this.connection.open(roomId);
        } else {
            // Receiver joins room
            this.connection.join(roomId);
        }
        
        return true;
    }
    
    bridgeSignaling(roomId) {
        // Intercept RTCMultiConnection's signaling attempts
        // and route them through our custom WebSocket
        
        // Note: This is a simplified bridge
        // RTCMultiConnection expects Socket.io, but we can adapt messages
        const originalEmit = this.connection.emit;
        
        // Override emit to use our WebSocket
        this.connection.emit = (eventName, data) => {
            if (this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
                // Convert RTCMultiConnection events to our message format
                const message = {
                    type: 'rtc-signal',
                    event: eventName,
                    data: data,
                    roomId: roomId,
                    role: this.role
                };
                this.signalingWs.send(JSON.stringify(message));
            }
        };
        
        // Handle incoming WebSocket messages
        this.signalingWs.addEventListener('message', (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'rtc-signal') {
                    // Route to RTCMultiConnection
                    if (this.connection && this.connection.socket) {
                        // Simulate Socket.io event
                        if (this.connection.socket.on) {
                            this.connection.socket.on(message.event, message.data);
                        }
                    }
                }
            } catch (e) {
                // Not an RTCMultiConnection message, ignore
            }
        });
    }
    
    // Send data through data channel
    send(data) {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(data);
            return true;
        } else if (this.connection && this.isConnected) {
            // Fallback: use RTCMultiConnection's send method
            this.connection.send(data);
            return true;
        }
        return false;
    }
    
    // Get buffered amount for flow control
    getBufferedAmount() {
        if (this.dataChannel) {
            return this.dataChannel.bufferedAmount || 0;
        }
        return 0;
    }
    
    // Close connection
    close() {
        if (this.connection) {
            this.connection.close();
        }
        this.isConnected = false;
        this.dataChannel = null;
    }
    
    // Event handlers
    on(event, callback) {
        switch(event) {
            case 'connect':
                this.onConnectCallback = callback;
                break;
            case 'data':
                this.onDataCallback = callback;
                break;
            case 'error':
                this.onErrorCallback = callback;
                break;
            case 'close':
                this.onCloseCallback = callback;
                break;
        }
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RTCMultiConnectionWrapper;
}

