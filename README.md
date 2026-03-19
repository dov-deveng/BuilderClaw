# BuilderClaw

**AI back office for contractors.** Project management, estimating, safety, and accounts — all through WhatsApp.

BuilderClaw runs on your existing Claude subscription. No API keys, no monthly SaaS fees. Your data stays on your machine.

## What It Does

Send a WhatsApp message → Bear (your AI office manager) handles it or delegates to the right specialist:

| Agent | Role |
|-------|------|
| **Bear** | Main agent — receives everything, delegates as needed |
| **PM** | Project manager — schedules, RFIs, submittals |
| **Estimator** | Takeoffs, material lists, cost estimates |
| **Accounts** | Billing, invoicing, lien waivers |
| **Safety** | OSHA compliance, toolbox talks, incident docs |

## Quick Start

### Prerequisites
- [Node.js 18+](https://nodejs.org)
- [Docker Desktop](https://docker.com/products/docker-desktop)
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) with an active subscription
- WhatsApp on your phone

### Install

```bash
git clone https://github.com/dovcohen/BuilderClaw.git
cd BuilderClaw
npm install
docker build -t builderclaw-agent:latest .
```

Or one-liner:
```bash
curl -fsSL https://raw.githubusercontent.com/dovcohen/BuilderClaw/main/install.sh | bash
```

### Run

```bash
npm start
```

Open `http://localhost:3000` and follow the setup wizard.

## How It Works

1. **WhatsApp** messages come in via [Baileys](https://github.com/WhiskeySockets/Baileys)
2. **Bear** receives every message and decides what to do
3. Complex tasks get delegated to specialist agents (PM, Estimator, etc.)
4. Each agent runs **Claude Code in a Docker container** — isolated, secure
5. A **credential proxy** shares your Claude session with all containers (no API key needed)
6. Responses go back through WhatsApp

All data stays local in SQLite. Nothing leaves your machine except Claude API calls.

## Architecture

```
WhatsApp ←→ Express Server ←→ Bear Agent Container
                ↕                    ↕
           SQLite DB          PM / Estimator / Accounts / Safety
                ↕
         Credential Proxy → api.anthropic.com
```

## Dashboard

The web dashboard at `localhost:3000` shows:
- Live message feed
- Agent status (running/idle)
- Company memory (projects, contacts)
- Direct task input

## Project Structure

```
BuilderClaw/
├── src/
│   ├── index.js              # Entry point — Express + WhatsApp + pipeline
│   ├── agents/
│   │   ├── container-runner.js  # Docker container management
│   │   ├── credential-proxy.js  # Shares Claude auth with containers
│   │   └── prompts/            # System prompts per agent
│   ├── dashboard/
│   │   └── index.html          # Main dashboard UI
│   ├── setup/
│   │   └── index.html          # 5-step setup wizard
│   ├── memory/
│   │   └── db.js               # SQLite database layer
│   └── whatsapp/
│       └── client.js           # Baileys WhatsApp client
├── Dockerfile                  # Agent container image
├── install.sh                  # One-command installer
└── package.json
```

## License

MIT — Dove & Bear Inc.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
