#!/usr/bin/env node

/**
 * Cross-platform startup script that starts both TURN server and app server
 * Works on Windows, macOS, and Linux
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const TURN_CONFIG = path.join(__dirname, 'turnserver.conf');
const TURN_LOG = path.join(__dirname, 'turn.log');
const TURN_PORT = 3478;
const APP_PORT = process.env.PORT || 3000;

let turnProcess = null;
let appProcess = null;

// Cleanup function
function cleanup() {
    console.log('\n🛑 Shutting down servers...');
    
    if (turnProcess) {
        console.log('Stopping TURN server...');
        turnProcess.kill('SIGTERM');
    }
    
    if (appProcess) {
        console.log('Stopping app server...');
        appProcess.kill('SIGTERM');
    }
    
    setTimeout(() => {
        process.exit(0);
    }, 1000);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Check if command exists
function commandExists(command) {
    return new Promise((resolve) => {
        exec(`which ${command}`, (error) => {
            resolve(!error);
        });
    });
}

// Check if port is in use
function isPortInUse(port) {
    return new Promise((resolve) => {
        const net = require('net');
        const server = net.createServer();
        server.listen(port, () => {
            server.once('close', () => resolve(false));
            server.close();
        });
        server.on('error', () => resolve(true));
    });
}

// Start TURN server
async function startTURN() {
    const turnExists = await commandExists('turnserver');
    
    if (!turnExists) {
        console.log('⚠️  TURN server (coturn) not found.');
        console.log('Please install it:');
        console.log('  macOS: brew install coturn');
        console.log('  Ubuntu/Debian: sudo apt-get install coturn');
        console.log('  Or skip TURN server and use: npm start\n');
        return null;
    }
    
    if (await isPortInUse(TURN_PORT)) {
        console.log(`⚠️  Port ${TURN_PORT} already in use. Using existing TURN server.`);
        return null;
    }
    
    if (!fs.existsSync(TURN_CONFIG)) {
        console.log(`⚠️  TURN config file not found: ${TURN_CONFIG}`);
        return null;
    }
    
    console.log('🚀 Starting TURN server...');
    
    const turnProcess = spawn('turnserver', ['-c', TURN_CONFIG, '-v'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
    });
    
    turnProcess.stdout.on('data', (data) => {
        fs.appendFileSync(TURN_LOG, data.toString());
    });
    
    turnProcess.stderr.on('data', (data) => {
        fs.appendFileSync(TURN_LOG, data.toString());
    });
    
    turnProcess.on('error', (err) => {
        console.error('❌ Failed to start TURN server:', err.message);
    });
    
    // Wait a bit for TURN server to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    if (turnProcess.killed) {
        console.error('❌ TURN server failed to start. Check turn.log for details.');
        return null;
    }
    
    console.log(`✅ TURN server started on port ${TURN_PORT}`);
    return turnProcess;
}

// Start app server
async function startApp() {
    if (await isPortInUse(APP_PORT)) {
        console.log(`⚠️  Port ${APP_PORT} already in use. App server may already be running.`);
        return null;
    }
    
    console.log('🚀 Starting app server...');
    
    const appProcess = spawn('node', ['server.js'], {
        stdio: 'inherit',
        env: { ...process.env, PORT: APP_PORT },
        detached: false
    });
    
    appProcess.on('error', (err) => {
        console.error('❌ Failed to start app server:', err.message);
    });
    
    // Wait a bit for app server to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    if (appProcess.killed) {
        console.error('❌ App server failed to start.');
        return null;
    }
    
    console.log(`✅ App server started on port ${APP_PORT}`);
    console.log(`   URL: http://localhost:${APP_PORT}\n`);
    return appProcess;
}

// Main function
async function main() {
    console.log('🌐 P2P File Sharing App Startup\n');
    
    // Start TURN server
    turnProcess = await startTURN();
    
    // Start app server
    appProcess = await startApp();
    
    if (!appProcess) {
        console.error('❌ Failed to start app server. Exiting.');
        cleanup();
        return;
    }
    
    console.log('✨ Both servers are running!');
    console.log('   Press Ctrl+C to stop both servers\n');
    
    // Keep process alive
    appProcess.on('exit', (code) => {
        console.log(`\nApp server exited with code ${code}`);
        cleanup();
    });
}

main().catch((err) => {
    console.error('❌ Startup error:', err);
    cleanup();
});


