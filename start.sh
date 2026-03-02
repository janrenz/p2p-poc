#!/bin/bash

# Start script for P2P File Sharing App with TURN Server
# This script starts both the TURN server (coturn) and the Node.js app server

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
TURN_CONFIG="./turnserver.conf"
TURN_LOG="/tmp/turn.log"
TURN_PORT=3478
APP_PORT=${PORT:-3000}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check if port is in use
port_in_use() {
    lsof -i :"$1" >/dev/null 2>&1
}

# Function to cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}Shutting down...${NC}"
    if [ ! -z "$TURN_PID" ]; then
        echo "Stopping TURN server (PID: $TURN_PID)"
        kill $TURN_PID 2>/dev/null || true
    fi
    if [ ! -z "$APP_PID" ]; then
        echo "Stopping app server (PID: $APP_PID)"
        kill $APP_PID 2>/dev/null || true
    fi
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

echo -e "${GREEN}=== P2P File Sharing App Startup ===${NC}\n"

# Check if coturn is installed
if ! command_exists turnserver; then
    echo -e "${YELLOW}Warning: coturn is not installed.${NC}"
    echo "Installing coturn..."
    
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        if command_exists apt-get; then
            sudo apt-get update
            sudo apt-get install -y coturn
        elif command_exists yum; then
            sudo yum install -y coturn
        elif command_exists brew; then
            brew install coturn
        else
            echo -e "${RED}Error: Cannot install coturn automatically. Please install it manually.${NC}"
            echo "Ubuntu/Debian: sudo apt-get install coturn"
            echo "macOS: brew install coturn"
            exit 1
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if command_exists brew; then
            brew install coturn
        else
            echo -e "${RED}Error: Homebrew not found. Please install coturn manually: brew install coturn${NC}"
            exit 1
        fi
    else
        echo -e "${RED}Error: Unsupported OS. Please install coturn manually.${NC}"
        exit 1
    fi
fi

# Check if TURN port is already in use
if port_in_use $TURN_PORT; then
    echo -e "${YELLOW}Warning: Port $TURN_PORT is already in use.${NC}"
    echo "Trying to use existing TURN server..."
    TURN_PID=""
else
    # Start TURN server
    echo -e "${GREEN}Starting TURN server...${NC}"
    
    if [ ! -f "$TURN_CONFIG" ]; then
        echo -e "${RED}Error: TURN config file not found: $TURN_CONFIG${NC}"
        exit 1
    fi
    
    # Start turnserver in foreground for this script
    turnserver -c "$TURN_CONFIG" -v > "$TURN_LOG" 2>&1 &
    TURN_PID=$!
    
    # Wait a moment for TURN server to start
    sleep 2
    
    # Check if TURN server started successfully
    if ! kill -0 $TURN_PID 2>/dev/null; then
        echo -e "${RED}Error: TURN server failed to start. Check $TURN_LOG for details.${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✓ TURN server started (PID: $TURN_PID)${NC}"
    echo "  Port: $TURN_PORT"
    echo "  Log: $TURN_LOG"
fi

# Check if app port is already in use
if port_in_use $APP_PORT; then
    echo -e "${YELLOW}Warning: Port $APP_PORT is already in use.${NC}"
    echo "Trying to use existing app server..."
    APP_PID=""
else
    # Start Node.js app server
    echo -e "\n${GREEN}Starting app server...${NC}"
    
    if [ ! -f "package.json" ]; then
        echo -e "${RED}Error: package.json not found. Are you in the project directory?${NC}"
        exit 1
    fi
    
    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        echo "Installing dependencies..."
        npm install
    fi
    
    # Start the app server
    PORT=$APP_PORT node server.js &
    APP_PID=$!
    
    # Wait a moment for app server to start
    sleep 2
    
    # Check if app server started successfully
    if ! kill -0 $APP_PID 2>/dev/null; then
        echo -e "${RED}Error: App server failed to start.${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✓ App server started (PID: $APP_PID)${NC}"
    echo "  URL: http://localhost:$APP_PORT"
fi

echo -e "\n${GREEN}=== Both servers are running ===${NC}"
echo -e "${GREEN}TURN Server:${NC} localhost:$TURN_PORT"
echo -e "${GREEN}App Server:${NC} http://localhost:$APP_PORT"
echo -e "\n${YELLOW}Press Ctrl+C to stop both servers${NC}\n"

# Wait for processes
if [ ! -z "$TURN_PID" ] && [ ! -z "$APP_PID" ]; then
    wait $TURN_PID $APP_PID
elif [ ! -z "$TURN_PID" ]; then
    wait $TURN_PID
elif [ ! -z "$APP_PID" ]; then
    wait $APP_PID
fi


