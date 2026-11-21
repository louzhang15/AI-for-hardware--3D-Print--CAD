import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompanionVoice } from '../viewer/companion-voice.js';
import { placeSceneLabels } from '../viewer/scene-labels.js';

test('3D labels prioritize the selected pin and keep labels inside and apart', () => {
  const entries = [
    { text: 'D21', anchor: [45, 40], size: 37, direction: [1, 0] },
    { text: 'SDA', anchor: [55, 42], size: 37, direction: [1, 0] },
    { text: 'Part', anchor: [5, 3], size: 100 },
  ];
  const labels = placeSceneLabels(entries, 150, 90);
  assert.deepEqual(labels.map(({ text }) => text), ['D21', 'SDA']);
  const [first, second] = labels;
  assert.ok(first.x + first.width <= second.x || second.x + second.width <= first.x
    || first.y + 21 <= second.y || second.y + 21 <= first.y);
  assert.ok(labels.every((item) => item.x >= 0 && item.y >= 0 && item.x + item.width <= 150));
  assert.deepEqual(placeSceneLabels(entries, 150, 90, 1).map(({ text }) => text), ['D21']);
});

test('voice recognition supplies finalized text and spoken replies can be cancelled', () => {
  let microphone;
  let utterance;
  const texts = [];
  const states = [];
  const environment = {
    webkitSpeechRecognition: class {
      constructor() { microphone = this; }
      start() { this.onstart(); }
      stop() { this.onend(); }
      abort() { this.onend?.(); }
    },
    SpeechSynthesisUtterance: class {
      constructor(text) { this.text = text; }
    },
    speechSynthesis: {
      speak(value) { utterance = value; },
      cancel() { utterance = null; },
    },
  };
  const voice = createCompanionVoice({
    environment, onTranscript: (text) => texts.push(text), onState: ({ mode }) => states.push(mode),
  });
  voice.listen();
  microphone.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Where is SDA?' }], { isFinal: true })] });
  microphone.onend();
  assert.deepEqual(texts, ['Where is SDA?']);
  assert.ok(states.includes('listening'));
  voice.speak('Use the SDA marking.');
  assert.equal(utterance.text, 'Use the SDA marking.');
  assert.equal(states.at(-1), 'speaking');
  voice.stopSpeaking();
  assert.equal(utterance, null);
  assert.equal(states.at(-1), 'idle');
});
