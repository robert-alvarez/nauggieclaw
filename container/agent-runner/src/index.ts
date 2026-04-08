/**
 * NauggieClaww Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Uses the Auggie CLI (`auggie --print`) for agent execution.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is emitted as a single ContainerOutput JSON line.
 *   Multiple lines may appear (one per agent turn).
 */

import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/** Auggie model override — set via AUGGIE_MODEL env var injected by the host. */
const AUGGIE_MODEL = process.env.AUGGIE_MODEL || '';

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** Emit a ContainerOutput result line to stdout (NDJSON). */
function writeOutput(output: ContainerOutput): void {
  console.log(JSON.stringify(output));
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Write /tmp/mcp-config.json so auggie can start the IPC MCP server.
 * The MCP server is compiled alongside index.ts into /tmp/dist/.
 */
function writeMcpConfig(containerInput: ContainerInput): void {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const config = {
    mcpServers: {
      nauggieclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NAUGGIECLAW_CHAT_JID: containerInput.chatJid,
          NAUGGIECLAW_GROUP_FOLDER: containerInput.groupFolder,
          NAUGGIECLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
      gmail: {
        command: 'npx',
        args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
      },
    },
  };
  fs.writeFileSync('/tmp/mcp-config.json', JSON.stringify(config, null, 2));
  log(`MCP config written (server: ${mcpServerPath})`);
}

/**
 * Build the base set of auggie CLI arguments shared across all turns.
 * Session-specific flags (--resume) are added per-turn in runAuggieTurn().
 */
function buildAuggieArgs(containerInput: ContainerInput): string[] {
  const args = [
    '--print',
    '--quiet',
    '--output-format',
    'json',
    '--workspace-root',
    '/workspace/group',
    '--mcp-config',
    '/tmp/mcp-config.json',
  ];

  // Use model override if configured on the host (via AUGGIE_MODEL env var).
  if (AUGGIE_MODEL) {
    args.push('--model', AUGGIE_MODEL);
  }

  // Rules files: group-level first, then global (non-main only)
  const groupRules = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupRules)) {
    args.push('--rules', groupRules);
  }
  const globalRules = '/workspace/global/CLAUDE.md';
  if (!containerInput.isMain && fs.existsSync(globalRules)) {
    args.push('--rules', globalRules);
  }

  // Container skills: auto-discover SKILL.md files under /workspace/skills/
  // and load each as a --rules file so the agent has skill definitions as context.
  const skillsDir = '/workspace/skills';
  if (fs.existsSync(skillsDir)) {
    try {
      const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      for (const skill of skillDirs) {
        const skillMd = path.join(skillsDir, skill, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          args.push('--rules', skillMd);
        }
      }
      if (skillDirs.length > 0) {
        log(`Loaded ${skillDirs.length} container skill(s): ${skillDirs.join(', ')}`);
      }
    } catch (err) {
      log(`Warning: failed to read skills directory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Allow all MCP tools from the nauggieclaw server without prompting.
  // Using wildcard (*) is safer than listing individual tool names since auggie
  // may prefix MCP tools differently across versions (e.g. nauggieclaw__send_message).
  args.push('--permission', '*:allow');

  return args;
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Spawn one `auggie --print` turn for the given prompt and session.
 * Parses NDJSON stdout for result lines and calls writeOutput() for each.
 * Returns the session_id from the final result (for the next --resume call).
 */
async function runAuggieTurn(
  prompt: string,
  sessionId: string | undefined,
  baseArgs: string[],
): Promise<{ newSessionId?: string; isError: boolean }> {
  const args = [...baseArgs];
  if (sessionId) {
    args.push('--resume', sessionId);
  }

  log(
    `Spawning auggie (session: ${sessionId || 'new'}, args: ${args.slice(0, 6).join(' ')}...)`,
  );

  return new Promise((resolve) => {
    const auggie = spawn('auggie', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    // Write prompt to auggie's stdin (auggie reads it when -i is not given)
    auggie.stdin.write(prompt, 'utf8');
    auggie.stdin.end();

    let lineBuffer = '';
    let newSessionId: string | undefined;
    let isError = false;
    let hadResult = false;

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed: {
          type: string;
          result?: string;
          is_error?: boolean;
          session_id?: string;
        } = JSON.parse(trimmed);

        if (parsed.type === 'result') {
          hadResult = true;
          if (parsed.session_id) newSessionId = parsed.session_id;
          const error = parsed.is_error === true;
          if (error) isError = true;

          writeOutput({
            status: error ? 'error' : 'success',
            result: parsed.result ?? null,
            newSessionId: parsed.session_id,
            error: error ? (parsed.result ?? 'Auggie reported an error') : undefined,
          });

          log(
            `Turn result: ${error ? 'ERROR' : 'OK'} session=${parsed.session_id ?? 'none'} len=${parsed.result?.length ?? 0}`,
          );
        }
      } catch {
        // Non-JSON stdout line — auggie may emit progress lines in some modes
      }
    };

    auggie.stdout.on('data', (data: Buffer) => {
      lineBuffer += data.toString('utf8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    });

    auggie.stderr.on('data', (data: Buffer) => {
      for (const line of data.toString('utf8').split('\n')) {
        if (line.trim()) log(`[auggie] ${line}`);
      }
    });

    auggie.on('close', (code) => {
      // Flush any remaining buffered output
      if (lineBuffer.trim()) processLine(lineBuffer);

      if (code !== 0 && !hadResult) {
        log(`Auggie exited with code ${code} and no result`);
        isError = true;
        writeOutput({
          status: 'error',
          result: null,
          error: `Auggie process exited with code ${code}`,
        });
      }

      log(`Auggie process done (code=${code}, isError=${isError})`);
      resolve({ newSessionId, isError });
    });

    auggie.on('error', (err: Error) => {
      log(`Auggie spawn error: ${err.message}`);
      isError = true;
      writeOutput({
        status: 'error',
        result: null,
        error: `Auggie spawn error: ${err.message}`,
      });
      resolve({ newSessionId, isError: true });
    });
  });
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Write MCP config and build base auggie args (reused every turn)
  writeMcpConfig(containerInput);
  const auggieBaseArgs = buildAuggieArgs(containerInput);

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pre-queued IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const preQueued = drainIpcInput();
  if (preQueued.length > 0) {
    log(`Draining ${preQueued.length} pending IPC messages into initial prompt`);
    prompt += '\n' + preQueued.join('\n');
  }

  // Script phase: run script before waking the agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({ status: 'success', result: null });
      return;
    }

    log('Script wakeAgent=true, enriching prompt with data');
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Turn loop: run auggie → check IPC → run auggie again → repeat
  try {
    while (true) {
      const { newSessionId, isError } = await runAuggieTurn(
        prompt,
        sessionId,
        auggieBaseArgs,
      );
      if (newSessionId) sessionId = newSessionId;

      if (isError) {
        log('Auggie error, exiting turn loop');
        break;
      }

      // Check for _close or messages that arrived during the auggie run
      if (shouldClose()) {
        log('Close sentinel found after turn, exiting');
        break;
      }

      const arrived = drainIpcInput();
      if (arrived.length > 0) {
        log(`${arrived.length} message(s) queued during turn, running next turn`);
        prompt = arrived.join('\n');
        continue;
      }

      // Emit idle marker so the host can start its idle timer
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Idle — waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`New message arrived (${nextMessage.length} chars), starting next turn`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Turn loop error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  } finally {
    // Archive the conversation transcript after the turn loop exits.
    // Replaces the old PreCompact hook — writes a dated markdown file to
    // /workspace/group/conversations/ so the agent can search past sessions.
    if (sessionId) {
      archiveSession(sessionId, containerInput.groupFolder).catch((err) => {
        log(`Session archive failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
}

/**
 * Read the auggie session JSON and write a human-readable markdown transcript
 * to /workspace/group/conversations/<date>-<sessionId-prefix>.md
 */
async function archiveSession(sessionId: string, groupFolder: string): Promise<void> {
  const HOME = process.env.HOME || '/home/node';
  const sessionFile = path.join(HOME, '.augment', 'sessions', `${sessionId}.json`);

  if (!fs.existsSync(sessionFile)) {
    log(`Session file not found for archiving: ${sessionFile}`);
    return;
  }

  interface ChatExchange {
    request_message?: string;
    response_text?: string;
  }
  interface SessionData {
    sessionId?: string;
    created?: string;
    chatHistory?: Array<{ exchange?: ChatExchange }>;
  }

  const raw = fs.readFileSync(sessionFile, 'utf-8');
  const data: SessionData = JSON.parse(raw);
  const history = data.chatHistory ?? [];

  if (history.length === 0) {
    log(`Session ${sessionId} has no chat history — skipping archive`);
    return;
  }

  const conversationsDir = '/workspace/group/conversations';
  fs.mkdirSync(conversationsDir, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10);
  const idPrefix = sessionId.slice(0, 8);
  const filename = `${dateStr}-${idPrefix}.md`;
  const filepath = path.join(conversationsDir, filename);

  // Build markdown lines
  const lines: string[] = [
    `# Conversation — ${dateStr}`,
    ``,
    `Session: \`${sessionId}\`  `,
    `Group: \`${groupFolder}\`  `,
    `Created: ${data.created ?? 'unknown'}`,
    ``,
    `---`,
    ``,
  ];

  for (const entry of history) {
    const ex = entry.exchange;
    if (!ex) continue;
    if (ex.request_message) {
      lines.push(`**User:** ${ex.request_message.trim()}`);
      lines.push('');
    }
    if (ex.response_text) {
      lines.push(`**Assistant:** ${ex.response_text.trim()}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  fs.writeFileSync(filepath, lines.join('\n'));
  log(`Session archived to ${filepath} (${history.length} exchange(s))`);
}

main();
