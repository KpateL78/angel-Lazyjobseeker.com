const { contextBridge, ipcRenderer } = require('electron');

// Channels the renderer is allowed to send on (to main).
const SEND_CHANNELS = new Set([
  'stream-audio-chunk',
  'toggle-recording',
  'stop-audio-stream',
  'reset-transcript',
  'new-chat',
  'toggle-screen-sharing-mode',
  'set-model',
  'set-preset',
  'summarize',
  'cancel-answer'
]);

// Channels the renderer is allowed to subscribe to (from main).
const RECEIVE_CHANNELS = new Set([
  'transcript',
  'recording-started',
  'recording-stopped',
  'answer',
  'answer-stream-start',
  'answer-stream-chunk',
  'answer-stream-end',
  'answer-status',
  'transcription-error',
  'screen-sharing-active',
  'config'
]);

contextBridge.exposeInMainWorld('api', {
  send(channel, payload) {
    if (!SEND_CHANNELS.has(channel)) {
      throw new Error(`Blocked send on unknown channel: ${channel}`);
    }
    ipcRenderer.send(channel, payload);
  },
  on(channel, listener) {
    if (!RECEIVE_CHANNELS.has(channel)) {
      throw new Error(`Blocked listen on unknown channel: ${channel}`);
    }
    const wrapped = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  once(channel, listener) {
    if (!RECEIVE_CHANNELS.has(channel)) {
      throw new Error(`Blocked listen on unknown channel: ${channel}`);
    }
    ipcRenderer.once(channel, (_event, ...args) => listener(...args));
  }
});
