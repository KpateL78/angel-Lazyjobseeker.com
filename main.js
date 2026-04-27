const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Load .env if present. dotenv is a no-op if the file is absent.
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) {
  // dotenv is optional in packaged builds where env vars are set externally
}

const speech = require('@google-cloud/speech');
const textToSpeech = require('@google-cloud/text-to-speech');
const OpenAI = require('openai');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const isWindows = process.platform === 'win32';

const SUPPORTED_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'];
const DEFAULT_MODEL = SUPPORTED_MODELS.includes(process.env.ANGEL_DEFAULT_MODEL)
  ? process.env.ANGEL_DEFAULT_MODEL
  : 'gpt-4o-mini';

const PRESETS = {
  general: {
    label: 'General',
    system:
      "You are a helpful AI assistant in a meeting. Your answers must be brief, clear, and direct - no more than 2-3 sentences."
  },
  interview: {
    label: 'Interview',
    system:
      "You are a coach helping the user answer interview questions in real time. Reply with a concise, structured answer in first person, no more than 4 sentences. Use the STAR method when relevant."
  },
  sales: {
    label: 'Sales call',
    system:
      "You are a sales assistant. The user is on a sales call. Respond as if you were them: concise, persuasive, and focused on value, objections, and next steps. 2-3 sentences."
  },
  standup: {
    label: 'Standup',
    system:
      "You are a standup helper. Keep answers in 1-2 short sentences with concrete blockers, progress, or next actions."
  },
  brainstorm: {
    label: 'Brainstorm',
    system:
      "You are a creative brainstorming partner. Offer 3 short, distinct ideas as a bulleted list. Keep each idea under 15 words."
  }
};
const DEFAULT_PRESET = PRESETS[process.env.ANGEL_DEFAULT_PRESET] ? process.env.ANGEL_DEFAULT_PRESET : 'general';

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

let mainWindow = null;
let recognizeStream = null;
let isRecording = false;
let currentTranscript = '';
let isInScreenSharingMode = false;

// In-memory conversation history (full transcript / answer pairs).
// Reset by 'reset-transcript' or 'new-chat' from the renderer.
/** @type {{role: 'user' | 'assistant', content: string}[]} */
let conversation = [];

let activeModel = DEFAULT_MODEL;
let activePreset = DEFAULT_PRESET;
let activeAnswerAbort = null;

// -----------------------------------------------------------------------------
// Credentials / clients
// -----------------------------------------------------------------------------

function resolveGoogleCredentialsPath() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) return envPath;

  // Production: look in the resources directory next to the app bundle.
  if (app.isPackaged) {
    const candidates = [
      path.join(process.resourcesPath, 'gcp-credentials.json'),
      path.join(process.resourcesPath, 'lazy-job-seeker-4b29b-eb0b308d0ba7.json')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return candidates[0];
  }

  // Dev: look next to main.js.
  const candidates = [
    path.join(__dirname, 'gcp-credentials.json'),
    path.join(__dirname, 'lazy-job-seeker-4b29b-eb0b308d0ba7.json')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

if (!process.env.OPENAI_API_KEY) {
  console.error(
    '[angel] OPENAI_API_KEY is not set. Set it in your environment or in a .env file. ' +
      'See SETUP.md / .env.example for details.'
  );
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
  maxRetries: 3,
  timeout: 60000
});

const credentialsPath = resolveGoogleCredentialsPath();
const speechClient = new speech.SpeechClient({ keyFilename: credentialsPath });
// eslint-disable-next-line no-unused-vars
const ttsClient = new textToSpeech.TextToSpeechClient({ keyFilename: credentialsPath });

// -----------------------------------------------------------------------------
// Window
// -----------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 520,
    alwaysOnTop: true,
    transparent: false,
    frame: true,
    skipTaskbar: false,
    icon: path.join(__dirname, isWindows ? 'assets/icons/icon.ico' : 'assets/icons/icon.png'),
    backgroundColor: '#FFFFFF',
    titleBarStyle: 'default',
    webPreferences: {
      // Lock down the renderer.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // sandbox: true breaks getUserMedia on some platforms; preload is still scoped via contextBridge
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');

  if (process.platform === 'darwin') {
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      mainWindow.setWindowButtonVisibility(true);
      app.dock.show();
      mainWindow.moveTop();
    });
  } else if (isWindows) {
    mainWindow.setSkipTaskbar(false);
    app.setAppUserModelId('com.lazyjobseeker.angel');
  }

  mainWindow.webContents.once('did-finish-load', () => {
    sendConfig();
  });

  console.log('Main window created');
}

function sendConfig() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('config', {
    models: SUPPORTED_MODELS,
    activeModel,
    presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.label])),
    activePreset,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    credentialsPath
  });
}

// -----------------------------------------------------------------------------
// Speech-to-Text streaming
// -----------------------------------------------------------------------------

function createRecognizeStream() {
  const request = {
    config: {
      encoding: 'WEBM_OPUS',
      sampleRateHertz: 48000,
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
      model: 'default',
      useEnhanced: true,
      metadata: {
        interactionType: 'DISCUSSION',
        microphoneDistance: 'NEARFIELD',
        originalMediaType: 'AUDIO'
      },
      maxAlternatives: 1
    },
    interimResults: true
  };

  return speechClient
    .streamingRecognize(request)
    .on('error', error => {
      console.error('Speech stream error:', error);
      if (error.code === 11 && isRecording) {
        // Stream timed out (>5min) — restart while preserving transcript.
        console.log('Speech stream timeout — recreating');
        recognizeStream = createRecognizeStream();
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', currentTranscript);
      }
    })
    .on('data', data => {
      if (!data.results[0]) return;
      const result = data.results[0];
      const transcript = result.alternatives[0].transcript;

      if (result.isFinal) {
        currentTranscript = (currentTranscript + ' ' + transcript).trim();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('transcript', currentTranscript);
        }
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        const interim = (currentTranscript + ' ' + transcript).trim();
        mainWindow.webContents.send('transcript', interim);
      }
    });
}

// -----------------------------------------------------------------------------
// IPC: recording / transcript
// -----------------------------------------------------------------------------

ipcMain.on('toggle-recording', async (_event, isStarting) => {
  if (isStarting) {
    console.log('Starting recording session');
    isRecording = true;
    currentTranscript = '';
    recognizeStream = createRecognizeStream();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-started');
      mainWindow.webContents.send('transcript', '');
    }
    return;
  }

  console.log('Stopping recording, generating answer');
  isRecording = false;

  if (recognizeStream) {
    try {
      recognizeStream.end();
    } catch (e) {
      console.error('Error ending recognizeStream:', e);
    }
    recognizeStream = null;
  }

  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('recording-stopped');

  if (currentTranscript && currentTranscript.trim().length > 0) {
    try {
      mainWindow.webContents.send('answer-status', 'Generating answer...');
      await streamAnswer(currentTranscript);
    } catch (error) {
      console.error('Error generating answer:', error);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('answer', 'Error generating answer. Please try again.');
      }
    }
  } else {
    mainWindow.webContents.send('answer', 'No speech detected. Please try again.');
  }
});

ipcMain.on('stream-audio-chunk', (_event, audioChunk) => {
  try {
    if (!isRecording) return;
    if (!recognizeStream || recognizeStream.destroyed) {
      recognizeStream = createRecognizeStream();
      isRecording = true;
    }
    if (recognizeStream && !recognizeStream.destroyed) {
      const buffer = Buffer.from(audioChunk, 'base64');
      try {
        recognizeStream.write(buffer);
      } catch (e) {
        console.error('Stream write error:', e);
      }
    }
  } catch (e) {
    console.error('Error processing audio chunk:', e);
  }
});

ipcMain.on('stop-audio-stream', () => {
  if (recognizeStream && !recognizeStream.destroyed) {
    isRecording = false;
    recognizeStream.end();
    recognizeStream = null;
  }
});

ipcMain.on('reset-transcript', () => {
  currentTranscript = '';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('transcript', '');
  }
});

ipcMain.on('new-chat', () => {
  currentTranscript = '';
  conversation = [];
  if (isRecording) {
    isRecording = false;
    if (recognizeStream) {
      try {
        recognizeStream.end();
      } catch (_) {
        /* noop */
      }
      recognizeStream = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-stopped');
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('transcript', '');
  }
});

// -----------------------------------------------------------------------------
// IPC: model + preset + summarize
// -----------------------------------------------------------------------------

ipcMain.on('set-model', (_event, model) => {
  if (SUPPORTED_MODELS.includes(model)) {
    activeModel = model;
    console.log('Active model:', activeModel);
  }
});

ipcMain.on('set-preset', (_event, preset) => {
  if (PRESETS[preset]) {
    activePreset = preset;
    console.log('Active preset:', activePreset);
  }
});

ipcMain.on('cancel-answer', () => {
  if (activeAnswerAbort) {
    try {
      activeAnswerAbort.abort();
    } catch (_) {
      /* noop */
    }
    activeAnswerAbort = null;
  }
});

ipcMain.on('summarize', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (conversation.length === 0 && !currentTranscript) {
    mainWindow.webContents.send('answer', 'Nothing to summarize yet — record something first.');
    return;
  }

  const transcriptDump = [
    ...conversation.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`),
    currentTranscript ? `User (live): ${currentTranscript}` : ''
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content:
        "You are an assistant that summarizes meeting transcripts. Output exactly two sections in markdown:\n" +
        "**Summary** — 2-4 short bullet points capturing the discussion.\n" +
        "**Action items** — a bulleted list of concrete next actions, each starting with an owner if mentioned, otherwise '— '."
    },
    { role: 'user', content: `Transcript so far:\n\n${transcriptDump}` }
  ];

  try {
    mainWindow.webContents.send('answer-status', 'Summarizing...');
    await streamCompletion(messages, { synthetic: '[Summarize]' });
  } catch (e) {
    console.error('Summarize error:', e);
    mainWindow.webContents.send('answer', `Sorry, summarize failed: ${e.message}`);
  }
});

// -----------------------------------------------------------------------------
// OpenAI streaming
// -----------------------------------------------------------------------------

async function streamAnswer(userText) {
  const messages = [
    { role: 'system', content: PRESETS[activePreset].system },
    ...conversation,
    { role: 'user', content: userText }
  ];
  await streamCompletion(messages, { userText });
}

/**
 * Streams an OpenAI chat completion to the renderer via IPC.
 * Sends `answer-stream-start`, repeated `answer-stream-chunk`, and `answer-stream-end`.
 * On failure, falls back to a single `answer` event with an error message.
 */
async function streamCompletion(messages, opts = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!process.env.OPENAI_API_KEY) {
    mainWindow.webContents.send(
      'answer',
      'OPENAI_API_KEY is not set. Add it to your .env file and restart Angel.'
    );
    return;
  }

  // Try active model first, then fall back through SUPPORTED_MODELS.
  const orderedModels = [activeModel, ...SUPPORTED_MODELS.filter(m => m !== activeModel)];

  // Cancel any prior in-flight answer.
  if (activeAnswerAbort) {
    try {
      activeAnswerAbort.abort();
    } catch (_) {
      /* noop */
    }
  }
  const abortController = new AbortController();
  activeAnswerAbort = abortController;

  let lastError = null;
  for (const model of orderedModels) {
    try {
      const stream = await openai.chat.completions.create(
        {
          model,
          messages,
          temperature: 0.3,
          max_tokens: 400,
          stream: true
        },
        { signal: abortController.signal }
      );

      mainWindow.webContents.send('answer-stream-start', { model, userText: opts.userText || opts.synthetic || '' });
      let full = '';
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('answer-stream-chunk', delta);
          }
        }
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('answer-stream-end', { full, model });
      }

      // Persist to conversation history (skip synthetic entries like summaries).
      if (opts.userText) {
        conversation.push({ role: 'user', content: opts.userText });
        conversation.push({ role: 'assistant', content: full });
        // Cap history to keep token usage bounded.
        const MAX_TURNS = 20;
        if (conversation.length > MAX_TURNS * 2) {
          conversation = conversation.slice(-MAX_TURNS * 2);
        }
      }

      activeAnswerAbort = null;
      return;
    } catch (err) {
      if (err?.name === 'AbortError') {
        console.log('Answer aborted');
        activeAnswerAbort = null;
        return;
      }
      console.error(`Model ${model} failed:`, err.message || err);
      lastError = err;
      // Try next model
    }
  }

  activeAnswerAbort = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const msg = lastError ? lastError.message : 'unknown error';
    mainWindow.webContents.send('answer', `Sorry, I couldn't generate an answer: ${msg}`);
  }
}

// -----------------------------------------------------------------------------
// Screen sharing exclusion (unchanged behavior, refactored for clarity)
// -----------------------------------------------------------------------------

ipcMain.on('toggle-screen-sharing-mode', (_event, isScreenSharing) => {
  if (!mainWindow) return;
  isInScreenSharingMode = isScreenSharing;

  if (isScreenSharing) {
    if (process.platform === 'darwin') {
      try {
        mainWindow.setContentProtection(true);
        mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        mainWindow.setAlwaysOnTop(true, 'floating', 1);
        mainWindow.setWindowButtonVisibility(false);
        mainWindow.setOpacity(0.99);

        const bounds = mainWindow.getBounds();
        mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width + 1, height: bounds.height });
        setTimeout(() => mainWindow.setBounds(bounds), 10);

        mainWindow.setVibrancy('popover');
        setTimeout(() => mainWindow.setVibrancy(null), 50);
      } catch (e) {
        console.error('macOS screen-sharing protection failed:', e);
      }
    } else if (isWindows) {
      try {
        mainWindow.setContentProtection(true);
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
      } catch (e) {
        console.error('Windows screen-sharing protection failed:', e);
      }
    }
    mainWindow.webContents.send('screen-sharing-active', true);
    return;
  }

  try {
    mainWindow.setOpacity(1.0);
    if (process.platform === 'darwin') {
      mainWindow.setWindowButtonVisibility(true);
      mainWindow.setVisibleOnAllWorkspaces(false);
    }
    mainWindow.setAlwaysOnTop(true);
    mainWindow.setContentProtection(false);
    if (process.platform === 'darwin') {
      const bounds = mainWindow.getBounds();
      mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width + 1, height: bounds.height });
      setTimeout(() => mainWindow.setBounds(bounds), 10);
    }
    mainWindow.webContents.send('screen-sharing-active', false);
  } catch (e) {
    console.error('Disable screen-sharing failed:', e);
  }
});

// -----------------------------------------------------------------------------
// App lifecycle
// -----------------------------------------------------------------------------

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
