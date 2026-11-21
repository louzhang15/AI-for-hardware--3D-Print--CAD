import { createCompanionVoice } from './companion-voice.js';
import { readDiagnosticLog } from './companion-log.js';
import { setupCompanionContext } from './companion-context.js';

const id = (name) => document.getElementById(name);
const question = id('question');
const mic = id('microphone');
const micLabel = id('mic-label');
const status = id('status');
const send = id('send');
const form = id('question-form');
const sendError = id('send-error');
const readReplies = id('read-replies');
const response = id('response');
const handoff = id('handoff');
const handoffText = id('handoff-text');
const replay = id('replay');
const copyReply = id('copy-reply');
const copyHandoff = id('copy');
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
const opener = id('open-evidence');
const dialog = id('evidence-dialog');
let mode = 'idle';
let busy = false;
let timer;
let activeRequest;
let spokenReply = '';
let bambuText = '';
let diagnosticLog;
let readingLog = false;
let readingBambu = false;

try {
  if (JSON.parse(localStorage.getItem('wiremap:theme')) === 'dark') document.documentElement.dataset.theme = 'dark';
} catch { /* Use the default theme. */ }
const linkedProject = new URLSearchParams(location.search).get('project');
if (linkedProject) {
  id('workspace-link').href = `/#/p/${encodeURIComponent(linkedProject)}`;
  id('workspace-link').textContent = 'Back to project';
}

const voice = createCompanionVoice({
  onTranscript(text) {
    const draft = question.value.trim();
    question.value = (draft ? `${draft} ${text}` : text).slice(0, question.maxLength);
    updateControls();
  },
  onState({ mode: voiceMode, message }) {
    mode = voiceMode;
    panel.dataset.state = busy ? 'thinking' : mode;
    micLabel.textContent = mode === 'listening' ? 'Stop listening' : mode === 'speaking' ? 'Stop speaking' : 'Talk';
    status.textContent = message || (voice.canListen ? 'Mic off' : 'Voice input unavailable. You can type below.');
    updateControls();
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

function updateControls() {
  const loading = readingLog || readingBambu || diagnosticContext.isLoading();
  send.disabled = busy || loading || !question.value.trim();
  opener.disabled = busy;
  attachLog.disabled = busy || readingLog;
  bambu.disabled = busy || readingBambu;
  id('remove-log').disabled = busy;
  id('remove-bambu').disabled = busy;
  mic.disabled = (!voice.canListen && mode !== 'speaking') || busy;
}

function setBusy(value) {
  busy = value;
  diagnosticContext.setLocked(value);
  updateControls();
}

function setReply(text) {
  if (reply.textContent !== text) reply.textContent = text;
}

async function request(url, options) {
  const result = await fetch(url, options);
  const data = await result.json();
  if (!result.ok) throw new Error(data.error || 'Wiremap could not complete the request.');
  return data;
}
const diagnosticContext = setupCompanionContext(request, { onChange: updateControls });
question.addEventListener('input', updateControls);
question.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  if (!send.disabled) form.requestSubmit();
});
opener.addEventListener('click', () => dialog.showModal());
dialog.addEventListener('click', (event) => {
  if (event.target.closest('.evidence-options button')) dialog.close();
});
dialog.addEventListener('close', () => opener.focus());

const attachments = [id('project-context'), logContext, id('solidworks-context'), bambuContext];
function renderEvidenceCount() {
  const total = attachments.filter((item) => !item.hidden).length;
  id('evidence-empty').hidden = total > 0;
  id('evidence-count').hidden = total === 0;
  id('evidence-count').textContent = String(total);
}
const observer = new MutationObserver(renderEvidenceCount);
for (const item of attachments) observer.observe(item, { attributes: true, attributeFilter: ['hidden'] });
renderEvidenceCount();
updateControls();

bambu.addEventListener('click', async () => {
  readingBambu = true;
  updateControls();
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
    readingBambu = false;
    updateControls();
  }
});

function removeBambu() {
  bambuText = '';
  bambuContext.hidden = true;
  bambuPreview.textContent = '';
}

id('remove-bambu').addEventListener('click', () => {
  removeBambu();
  opener.focus();
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
  updateControls();
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
    updateControls();
  }
});
id('remove-log').addEventListener('click', () => {
  removeLog();
  opener.focus();
});

async function poll(current) {
  if (activeRequest !== current) return;
  try {
    const data = await request(`/api/companion/${encodeURIComponent(current.id)}`);
    if (activeRequest !== current) return;
    if (data.reply) {
      activeRequest = undefined;
      setBusy(false);
      spokenReply = data.reply;
      setReply(spokenReply);
      copyReply.hidden = false;
      replay.hidden = !voice.canSpeak;
      handoff.hidden = false;
      if (readReplies.checked) voice.speak(spokenReply);
      return;
    }
    if (data.status === 'answering') {
      setReply('Codex is working on it…');
    } else {
      setBusy(false);
      setReply(data.error || (data.status === 'dismissed' ? 'This request was dismissed.'
        : 'A reply can come back from an open Codex or Claude Code chat.'));
      handoff.hidden = false;
      if (data.status === 'dismissed' || data.status === 'done') {
        activeRequest = undefined;
        return;
      }
    }
    timer = setTimeout(() => poll(current), busy ? 900 : 2200);
  } catch {
    if (activeRequest !== current) return;
    setBusy(false);
    setReply('Waiting to reconnect to Wiremap…');
    handoff.hidden = false;
    timer = setTimeout(() => poll(current), 3000);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text || send.disabled) return;
  voice.cancelListening();
  voice.stopSpeaking();
  question.readOnly = true;
  sendError.hidden = true;
  const previousRequest = activeRequest;
  activeRequest = undefined;
  clearTimeout(timer);
  setBusy(true);
  try {
    const data = await request('/api/companion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, assistant: 'codex', bambu: bambuText || undefined, log: diagnosticLog, ...diagnosticContext.payload() }),
    });
    response.hidden = false;
    handoff.hidden = true;
    replay.hidden = true;
    copyReply.hidden = true;
    copyReply.textContent = 'Copy reply';
    copyHandoff.textContent = 'Copy prompt';
    id('sent-question').hidden = false;
    id('sent-text').textContent = text;
    setReply('Codex is working on it…');
    handoffText.value = data.prompt;
    question.value = '';
    activeRequest = { id: data.id };
    poll(activeRequest);
  } catch (error) {
    sendError.hidden = false;
    sendError.textContent = error.message;
    setBusy(false);
    if (previousRequest) {
      activeRequest = { id: previousRequest.id };
      poll(activeRequest);
    }
  } finally {
    question.readOnly = false;
  }
});

copyReply.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(spokenReply);
    copyReply.textContent = 'Copied';
  } catch {
    sendError.hidden = false;
    sendError.textContent = 'Copy is unavailable. Select the reply text to copy it manually.';
  }
});

copyHandoff.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(handoffText.value);
    copyHandoff.textContent = 'Copied';
  } catch {
    handoffText.focus();
    handoffText.select();
  }
});

window.addEventListener('pagehide', () => {
  clearTimeout(timer);
  voice.dispose();
});
