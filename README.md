<p align="center">
  <img src="claw-mascot.png" alt="BuilderClaw" width="120">
</p>

<h1 align="center">BuilderClaw</h1>

<p align="center">
  AI back office for contractors. Free forever.
</p>

---

## Download

**[Download BuilderClaw for Mac](https://github.com/dov-deveng/BuilderClaw/releases/latest)**

1. Download the `.dmg` file from the link above
2. Open the `.dmg` and drag BuilderClaw into your Applications folder
3. Double-click BuilderClaw in Applications
4. **If macOS says the app "is damaged" or "can't be opened":** Open **System Settings** → **Privacy & Security** → scroll down and click **Open Anyway** next to the BuilderClaw message. You only have to do this once.
5. Follow the setup wizard (takes about 5 minutes)

You'll need [Docker Desktop](https://docker.com/products/docker-desktop) installed and a [Claude](https://claude.ai) subscription. The setup wizard walks you through everything.

---

## What You Get

Text your AI team from WhatsApp or the built-in dashboard. Claw reads your message and handles it, or passes it to the right person:

| Agent | What they do |
|-------|-------------|
| Claw | Your main contact. Reads everything, delegates when needed |
| PM | Schedules, RFIs, submittals, project tracking |
| Estimator | Takeoffs, material lists, cost breakdowns |
| Accounts | Billing, invoicing, lien waivers, pay apps |
| Safety | OSHA compliance, toolbox talks, incident docs |
| Marketing | Social posts, proposals, client outreach |

You pick a trigger word during setup (like `@Claw`). Messages without it are ignored, so your other WhatsApp chats stay private.

## How It Works

1. You send a WhatsApp message with your trigger word
2. Claw picks it up and figures out what to do
3. If it's a big task, Claw hands it to the right specialist agent
4. You get a reply in the same chat

All your data stays on your computer. Nothing is stored in the cloud.

## Requirements

- Mac (Apple Silicon or Intel)
- [Docker Desktop](https://docker.com/products/docker-desktop)
- A [Claude](https://claude.ai) subscription (Pro or Team)
- WhatsApp on your phone

## For Developers

Want to run from source or contribute?

```bash
git clone https://github.com/dov-deveng/BuilderClaw.git
cd BuilderClaw
npm install
npm start
```

Open `http://localhost:3000` and follow the setup wizard.

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - Dove & Bear Inc.
