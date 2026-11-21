import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const prompt = 'Answer the following explicitly submitted question for the Wiremap voice companion. '
  + 'Respond directly in a few plain-text sentences suitable for reading aloud. '
  + 'Use only the text provided. Ask for the relevant measurement, model, or error if the question needs more context.\n\n';

export function askCompanionCodex(text) {
  const args = [
    '--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--ephemeral',
    '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json', '--color', 'never',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'hooks', '--disable', 'plugins',
    '-c', 'web_search="disabled"', '-',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      signal: AbortSignal.timeout(55_000),
    });
    let output = '';
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      if (output.length > 260_000) child.kill();
    });
    child.on('close', (code) => {
      if (code !== 0 || output.length > 260_000) return reject(new Error('Codex did not complete the answer.'));
      let answer;
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text;
        } catch { /* Ignore diagnostics from the CLI. */ }
      }
      if (!answer?.trim()) return reject(new Error('Codex did not return a reply.'));
      resolve(answer.trim().slice(0, 4000));
    });
    child.stdin.end(prompt + text);
  });
}
