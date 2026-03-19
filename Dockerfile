# BuilderClaw Agent Container
# Each agent runs Claude Code inside this container.
# Credentials are injected via the credential proxy — never baked into the image.

FROM node:20-slim

# Install system deps for Claude Code CLI
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create workspace
RUN mkdir -p /workspace && chmod 777 /workspace
WORKDIR /workspace

# Default: run Claude Code in non-interactive mode
# The container-runner passes the actual task via --print flag
ENTRYPOINT ["claude"]
