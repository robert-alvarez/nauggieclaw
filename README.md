<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NauggieClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs Auggie agents securely in their own containers.<br>
  Lightweight, fully understandable, and completely customizable.
</p>

<p align="center">
  <a href="https://github.com/jboothomas/nauggieclaw">github</a>&nbsp; • &nbsp;
  <a href="https://augmentcode.com">augmentcode.com</a>
</p>

---

> **Based on [NanoClaw](https://github.com/qwibitai/nanoclaw)** by qwibitai — adapted to run on [Augment Code's](https://augmentcode.com) `auggie` agent instead of Claude Code. The core architecture (containers, channels, IPC, skills) is unchanged. Only the agent execution layer has been swapped: `auggie` replaces the Claude Code SDK, and `AUGMENT_SESSION_AUTH` replaces Anthropic API keys. All credit for the original design goes to the NanoClaw team.

---

## Why NauggieClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation — and it has nearly half a million lines of code. NanoClaw solved that with a tiny, auditable codebase where agents run in isolated Linux containers.

NauggieClaw takes NanoClaw's architecture and swaps in Auggie as the agent runtime. If you already use Augment Code and want a self-hosted assistant that runs on your existing subscription — no Anthropic API key required — this is it.

## Quick Start

```bash
gh repo fork jboothomas/nauggieclaw --clone
cd nauggieclaw
auggie
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [jboothomas/nauggieclaw](https://github.com/jboothomas/nauggieclaw) on GitHub (click the Fork button)
2. `git clone https://github.com/<your-username>/nauggieclaw.git`
3. `cd nauggieclaw`
4. `auggie`

</details>

Then run `/setup`. Auggie handles everything: dependencies, authentication, container setup and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are skills — type them inside the `auggie` prompt. If you don't have Auggie installed, get it at [augmentcode.com](https://augmentcode.com).

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NauggieClaw codebase, just ask Auggie to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NauggieClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NauggieClaw is designed to be bespoke. You make your own fork and have Auggie modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Auggie guides setup.
- No monitoring dashboard; ask Auggie what's happening.
- No debugging tools; describe the problem and Auggie fixes it.

**Skills over features.** Instead of adding features to the codebase, contributors submit skills like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** NauggieClaw runs on Auggie — Augment Code's agent. Auggie's coding and problem-solving capabilities let it modify and expand NauggieClaw and tailor it to each user, all from within your existing Augment subscription.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Docker (macOS/Linux), [Docker Sandboxes](docs/docker-sandboxes.md) (micro VM isolation), or Apple Container (macOS)
- **Credential security** - Agents never hold raw API keys. Auggie authentication is handled via `AUGMENT_SESSION_AUTH` injected at container start — credentials are never baked into the image.
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NauggieClaw doesn't use configuration files. To make changes, just tell Auggie what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Auggie can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram to the core codebase. Instead, fork NauggieClaw, make the code changes on a branch, and open a PR. We'll create a `skill/telegram` branch from your PR that other users can merge into their fork.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` - Add Signal as a channel

## Requirements

- macOS, Linux, or Windows (via WSL2)
- Node.js 20+
- [Augment Code](https://augmentcode.com) with `auggie` CLI installed
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Auggie) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see the [docs](https://github.com/jboothomas/nauggieclaw).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime. For additional isolation, [Docker Sandboxes](docs/docker-sandboxes.md) run each container inside a micro VM.

**Can I run this on Linux or Windows?**

Yes. Docker is the default runtime and works on macOS, Linux, and Windows (via WSL2). Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Credentials never enter the container as raw keys — `AUGMENT_SESSION_AUTH` is injected at container start time and is the only credential the agent ever sees. You should still review what you're running, but the codebase is small enough that you actually can.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NauggieClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Auggie to add them.

**Can I use a different model?**

Yes. Auggie supports model overrides via the `AUGGIE_MODEL` env var in your `.env` file:

```bash
AUGGIE_MODEL=claude-sonnet-4-5  # or any model Augment supports
```

For local models, use the `/add-ollama-tool` skill to give agents access to locally running Ollama models without replacing Auggie as the orchestrator.

**How do I debug issues?**

Ask Auggie. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NauggieClaw.

**Why isn't the setup working for me?**

If you have issues during setup, Auggie will try to dynamically fix them. If that doesn't work, run `auggie`, then run `/debug`. If Auggie finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions, ideas, or contributions? Open an issue or PR at [jboothomas/nauggieclaw](https://github.com/jboothomas/nauggieclaw). For discussion about the upstream project, see [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes.

## License

MIT
