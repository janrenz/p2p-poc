// PeerServer for PeerJS signaling
// This is a simple PeerServer implementation
const express = require('express');
const { ExpressPeerServer } = require('peer');

const app = express();
const PORT = process.env.PEERJS_PORT || 9000;

const server = app.listen(PORT, () => {
  console.log(`PeerServer running on port ${PORT}`);
});

const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/peerjs',
  allow_discovery: true
});

app.use('/peerjs', peerServer);

peerServer.on('connection', (client) => {
  console.log(`Peer connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`Peer disconnected: ${client.getId()}`);
});

console.log(`PeerServer ready at http://localhost:${PORT}/peerjs`);

