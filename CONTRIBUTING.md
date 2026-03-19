# Contributing to BuilderClaw

Thanks for wanting to help. Here's how.

## Setup for Development

```bash
git clone https://github.com/dovcohen/BuilderClaw.git
cd BuilderClaw
npm install
docker build -t builderclaw-agent:latest .
npm start
```

## Guidelines

- **Keep it simple.** The target user is a contractor, not a developer.
- **ES modules** throughout (`import`/`export`, not `require`).
- **No TypeScript.** Plain JavaScript for easy contribution.
- **SQLite only.** No external databases.
- **Test on Docker Desktop** — that's what most users will have.

## What We Need Help With

- More trade-specific agent prompts
- WhatsApp message formatting improvements
- Dashboard UI enhancements
- Documentation and guides for specific trades
- Translations (Spanish is high priority for the trades)

## Pull Requests

1. Fork the repo
2. Create a branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test locally (setup wizard, WhatsApp connection, agent tasks)
5. Open a PR with a clear description

## Code Style

- 2-space indentation
- Double quotes for strings
- No semicolons (just kidding, use them)
- Keep functions small and focused

## Questions?

Open an issue or reach out to [@dovcohen](https://github.com/dovcohen).
