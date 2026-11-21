import { createCompanionVoice } from './companion-voice.js';
import { readDiagnosticLog } from './companion-log.js';
import { setupCompanionContext } from './companion-context.js';

const id = (name) => document.getElementById(name);
const question = id('question');
const mic = id('microphone');
const micLabel = id('mic-label');
const status = id('status');
const send = id('send');
const readReplies = id('read-replies');
const response = id('response');
const handoff = id('handoff');
const handoffText = id('handoff-text');
const replay = id('replay');
const reply = id('reply');
const panel = document.querySelector('.voice-panel');
const bambu = id('bambu');
const bambuContext = id('bambu-context');
const bambuPreview = id('bambu-preview');
const contextStatus = id('context-status');
const attachLog = id('attach-log');
const logFile = id('log-file');
const logContext = id('log-context');
const logLabel = id('log-label');
const logPreview = id('log-preview');
const logStatus = id('log-status');
let mode = 'idle';
let busy = false;
let timer;
let activeRequest;
let spokenReply = '';
let bambuText = '';
let diagnosticLog;
let readingLog = false;

const voice = createCompanionVoice({
  onTranscript(text) {
    const draft = question.value.trim();
    question.value = (draft ? `${draft} ${text}` : text).slice(0, question.maxLength);
  },
  onState({ mode: voiceMode, message }) {
    mode = voiceMode;
    panel.dataset.state = busy ? 'thinking' : mode;
    micLabel.textContent = mode === 'listening' ? 'Stop listening' : mode === 'speaking' ? 'Stop speaking' : 'Talk';
    mic.setAttribute('aria-pressed', String(mode === 'listening'));
    if (!busy) status.textContent = message || 'Microphone off';
  },
});

mic.disabled = !voice.canListen;
if (!voice.canListen) status.textContent = 'Voice input unavailable. You can type below.';
readReplies.disabled = !voice.canSpeak;
if (!voice.canSpeak) readReplies.checked = false;
mic.addEventListener('click', () => {
  if (mode === 'listening') voice.stopListening();
  else if (mode === 'speaking') voice.stopSpeaking();
  else if (!busy) voice.listen();
});
readReplies.addEventListener('change', () => { if (!readReplies.checked) voice.stopSpeaking(); });
replay.addEventListener('click', () => voice.speak(spokenReply));

function setBusy(value) {
  busy = value;
  send.disabled = value || readingLog;
  attachLog.disabled = value || readingLog;
  mic.disabled = value || !voice.canListen;
  panel.dataset.state = value ? 'thinking' : mode;
}

async function request(url, options) {
  const result = await fetch(url, options);
  const data = await result.json();
  if (!result.ok) throw new Error(data.error || 'Wiremap could not complete the request.');
  return data;
}
const diagnosticContext = setupCompanionContext(request);

bambu.addEventListener('click', async () => {
  bambu.disabled = true;
  contextStatus.hidden = true;
  try {
    const data = await request('/api/companion/bambu');
    if (data.status === 'saved') {
      bambuText = data.text;
      bambuPreview.textContent = data.text;
      bambuContext.hidden = false;
      bambuContext.open = true;
    } else {
      contextStatus.hidden = false;
      contextStatus.textContent = data.text;
    }
  } catch (error) {
    contextStatus.hidden = false;
    contextStatus.textContent = error.message;
  } finally {
    bambu.disabled = false;
  }
});

function removeBambu() {
  bambuText = '';
  bambuContext.hidden = true;
  bambuPreview.textContent = '';
}

id('remove-bambu').addEventListener('click', () => {
  removeBambu();
  bambu.focus();
});

function removeLog() {
  diagnosticLog = undefined;
  logContext.hidden = true;
  logPreview.textContent = '';
  logStatus.hidden = true;
}

attachLog.addEventListener('click', () => logFile.click());
logFile.addEventListener('change', async () => {
  const file = logFile.files[0];
  logFile.value = '';
  if (!file || busy || readingLog) return;
  removeLog();
  readingLog = true;
  send.disabled = true;
  attachLog.disabled = true;
  try {
    diagnosticLog = await readDiagnosticLog(file);
    logLabel.textContent = diagnosticLog.truncated ? `${diagnosticLog.name} (tail only)` : diagnosticLog.name;
    logPreview.textContent = diagnosticLog.text;
    logContext.hidden = false;
    logContext.open = true;
  } catch (error) {
    logStatus.textContent = error.message;
    logStatus.hidden = false;
  } finally {
    readingLog = false;
    send.disabled = busy;
    attachLog.disabled = busy;
  }
});
id('remove-log').addEventListener('click', () => {
  removeLog();
  attachLog.focus();
});

async function poll(id) {
  if (activeRequest !== id) return;
  try {
    const data = await request(`/api/companion/${encodeURIComponent(id)}`);
    if (activeRequest !== id) return;
    if (data.reply) {
      setBusy(false);
      status.textContent = 'Reply ready';
      spokenReply = data.reply;
      reply.textContent = spokenReply;
      replay.hidden = !voice.canSpeak;
      handoff.hidden = false;
      if (readReplies.checked) voice.speak(spokenReply);
      return;
    }
    if (data.status === 'answering') {
      reply.textContent = 'Codex is working on it…';
    } else {
      setBusy(false);
      status.textContent = 'Question saved';
      reply.textContent = data.error || 'A reply can come back from an open Codex or Claude Code chat.';
      handoff.hidden = false;
    }
    timer = setTimeout(() => poll(id), busy ? 900 : 2200);
  } catch {
    if (activeRequest !== id) return;
    setBusy(false);
    status.textContent = 'Connection interrupted';
    reply.textContent = 'Waiting to reconnect to Wiremap…';
    handoff.hidden = false;
    timer = setTimeout(() => poll(id), 3000);
  }
}

id('question-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text || busy || readingLog) return;
  if (diagnosticContext.isLoading()) {
    contextStatus.hidden = false;
    contextStatus.textContent = 'Wait for the project context to finish loading.';
    return;
  }
  if (text.length > question.maxLength) {
    contextStatus.hidden = false;
    contextStatus.textContent = 'Shorten your question before sending.';
    return;
  }
  voice.cancelListening();
  voice.stopSpeaking();
  clearTimeout(timer);
  activeRequest = null;
  setBusy(true);
  status.textContent = 'Thinking…';
  response.hidden = false;
  handoff.hidden = true;
  replay.hidden = true;
  reply.textContent = 'Sending your question…';
  try {
    const data = await request('/api/companion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, assistant: 'codex', bambu: bambuText || undefined, log: diagnosticLog, ...diagnosticContext.payload() }),
    });
    handoffText.value = data.prompt;
    question.value = '';
    removeBambu();
    removeLog();
    activeRequest = data.id;
    poll(activeRequest);
  } catch (error) {
    status.textContent = 'Could not send question';
    reply.textContent = error.message;
    setBusy(false);
  }
});

id('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(handoffText.value);
    status.textContent = 'Handoff prompt copied';
  } catch {
    handoffText.focus();
    handoffText.select();
  }
});

window.addEventListener('pagehide', () => {
  clearTimeout(timer);
  voice.dispose();
});
