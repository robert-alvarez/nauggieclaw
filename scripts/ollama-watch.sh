#!/usr/bin/env bash
# ollama-watch.sh — macOS notification watcher for Ollama activity.
# Tails logs/nauggieclaw.log and fires a macOS notification whenever
# the agent uses an Ollama tool. Run in a separate terminal window.
#
# Usage: ./scripts/ollama-watch.sh [logfile]

set -euo pipefail

LOG="${1:-logs/nauggieclaw.log}"

if [[ ! -f "$LOG" ]]; then
  echo "Waiting for log file: $LOG"
  while [[ ! -f "$LOG" ]]; do sleep 1; done
fi

echo "Watching $LOG for [OLLAMA] activity..."

tail -F "$LOG" | while IFS= read -r line; do
  if [[ "$line" == *"[OLLAMA]"* ]]; then
    # Extract the message part after [OLLAMA]
    msg="${line#*\[OLLAMA\] }"

    if [[ "$msg" == *">>> Generating"* ]]; then
      osascript -e "display notification \"$msg\" with title \"Ollama\" subtitle \"Generating...\""
    elif [[ "$msg" == *"<<< Done"* ]]; then
      osascript -e "display notification \"$msg\" with title \"Ollama\" subtitle \"Complete\""
    elif [[ "$msg" == *"Pulling model"* ]]; then
      osascript -e "display notification \"$msg\" with title \"Ollama\" subtitle \"Downloading model...\""
    elif [[ "$msg" == *"Pull complete"* ]]; then
      osascript -e "display notification \"$msg\" with title \"Ollama\" subtitle \"Model ready\""
    fi

    echo "[ollama-watch] $msg"
  fi
done
