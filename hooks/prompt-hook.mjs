#!/usr/bin/env node
// Claude Code UserPromptSubmit hook (opt-in, installed by `wiremap install --hook`).
// Reads the hook JSON on stdin; when the prompt is about hardware, CAD or 3D
// printing it adds a reminder to use the wiremap skill. Never blocks a prompt.
import { matchHardware, REMINDER } from './keywords.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; if (input.length > 1e6) process.stdin.destroy(); });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const { match } = matchHardware(data.prompt || '');
    if (match) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: REMINDER } }));
    }
  } catch { /* never break the user's prompt */ }
  process.exit(0);
});
