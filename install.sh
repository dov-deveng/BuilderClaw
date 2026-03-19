#!/bin/bash
# BuilderClaw — One-Command Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/dovcohen/BuilderClaw/main/install.sh | bash

set -e

REPO="https://github.com/dovcohen/BuilderClaw.git"
DIR="$HOME/BuilderClaw"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       BuilderClaw Installer          ║"
echo "  ║   AI Back Office for Contractors     ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Check prerequisites
check_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "  ✗ $1 not found. Please install $1 first."
    return 1
  fi
  echo "  ✓ $1 found"
  return 0
}

MISSING=0
check_cmd "node" || MISSING=1
check_cmd "npm" || MISSING=1
check_cmd "docker" || MISSING=1
check_cmd "git" || MISSING=1

if [ $MISSING -eq 1 ]; then
  echo ""
  echo "  Please install missing prerequisites and try again."
  echo "  - Node.js 18+: https://nodejs.org"
  echo "  - Docker Desktop: https://docker.com/products/docker-desktop"
  echo ""
  exit 1
fi

# Check Docker is running
if ! docker info &> /dev/null 2>&1; then
  echo ""
  echo "  ✗ Docker is not running. Please start Docker Desktop and try again."
  exit 1
fi
echo "  ✓ Docker is running"

# Check Node version
NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  ✗ Node.js 18+ required (found $(node -v))"
  exit 1
fi
echo "  ✓ Node.js $(node -v)"
echo ""

# Clone or update
if [ -d "$DIR" ]; then
  echo "  Updating existing installation..."
  cd "$DIR"
  git pull --ff-only
else
  echo "  Downloading BuilderClaw..."
  git clone "$REPO" "$DIR"
  cd "$DIR"
fi

# Install dependencies
echo "  Installing dependencies..."
npm install --production

# Build Docker image
echo "  Building agent container (this may take a minute)..."
docker build -t builderclaw-agent:latest .

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║         Installation Complete!       ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  To start BuilderClaw:"
echo ""
echo "    cd ~/BuilderClaw"
echo "    npm start"
echo ""
echo "  Then open http://localhost:3000 in your browser."
echo ""
