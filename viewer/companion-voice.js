const recognitionErrors = {
  'not-allowed': 'Microphone access is blocked. You can still type your question.',
  'service-not-allowed': 'Speech recognition is blocked by this browser. You can still type.',
  'audio-capture': 'No microphone could be used. Check your microphone or type your question.',
  network: 'The browser could not reach its speech service. You can still type.',
  'no-speech': 'No speech was heard. Try again or type your question.',
};

export function createCompanionVoice({ onTranscript = () => {}, onState = () => {}, lang, environment = globalThis } = {}) {
  const Recognition = environment.SpeechRecognition || environment.webkitSpeechRecognition;
  const Utterance = environment.SpeechSynthesisUtterance;
  const synthesis = environment.speechSynthesis;
  const canListen = typeof Recognition === 'function';
  const canSpeak = typeof Utterance === 'function' && Boolean(synthesis);
  let recognition = null;
  let recognitionStarted = false;
  let utterance = null;

  function state(mode, message = '') {
    onState({ mode, message });
  }

  function cancelListening() {
    if (!recognition) return;
    const current = recognition;
    recognition = null;
    recognitionStarted = false;
    current.abort();
    state('idle');
  }

  function stopListening() {
    if (!recognition) return;
    if (!recognitionStarted) {
      cancelListening();
      return;
    }
    recognition.stop();
  }

  function listen() {
    if (!canListen || recognition) return;
    stopSpeaking();
    try {
      const current = new Recognition();
      recognition = current;
      recognitionStarted = false;
      current.continuous = false;
      current.interimResults = false;
      if (lang) current.lang = lang;
      current.onstart = () => {
        if (recognition !== current) return;
        recognitionStarted = true;
        state('listening', 'Listening…');
      };
      const finish = (message) => {
        if (recognition !== current) return false;
        recognition = null;
        recognitionStarted = false;
        state('idle', message);
        return true;
      };
      current.onresult = (event) => {
        const words = [];
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) words.push(result[0].transcript);
        }
        const transcript = words.join(' ').trim();
        if (transcript && finish('')) onTranscript(transcript);
      };
      current.onend = () => finish('No speech was heard. Try again or type your question.');
      current.onerror = ({ error }) => finish(recognitionErrors[error] || 'Could not recognize speech. You can still type.');
      state('listening', 'Starting the microphone…');
      current.start();
    } catch {
      recognition = null;
      recognitionStarted = false;
      state('idle', 'Could not start the microphone. You can still type.');
    }
  }

  function stopSpeaking() {
    if (!utterance) return;
    utterance = null;
    synthesis.cancel();
    state('idle');
  }

  function speak(text) {
    const words = text?.trim();
    if (!canSpeak || !words) return;
    cancelListening();
    stopSpeaking();
    try {
      const current = new Utterance(words);
      utterance = current;
      if (lang) current.lang = lang;
      const finish = (message) => {
        if (utterance !== current) return;
        utterance = null;
        state('idle', message);
      };
      current.onend = () => finish('');
      current.onerror = () => finish('Could not read the reply aloud.');
      state('speaking', 'Reading the reply…');
      synthesis.speak(current);
    } catch {
      utterance = null;
      state('idle', 'Could not read the reply aloud.');
    }
  }

  function dispose() {
    cancelListening();
    stopSpeaking();
  }

  return { canListen, canSpeak, listen, stopListening, cancelListening, speak, stopSpeaking, dispose };
}
