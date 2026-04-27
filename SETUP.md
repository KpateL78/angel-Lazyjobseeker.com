# Setup Instructions

## 1. Install dependencies

```bash
npm install
```

## 2. Configure secrets via `.env`

Angel reads its credentials and defaults from environment variables. The easiest
way is to copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

The `.env` file is gitignored — never commit it.

### Required

| Variable                          | What it is                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                  | Your OpenAI API key. Create one at <https://platform.openai.com/api-keys>.                                  |
| `GOOGLE_APPLICATION_CREDENTIALS`  | Path to a Google Cloud service account JSON with Speech-to-Text + Text-to-Speech access. Absolute or relative to the project root. |

### Optional

| Variable                | Values                                              | Default        |
| ----------------------- | --------------------------------------------------- | -------------- |
| `ANGEL_DEFAULT_MODEL`   | `gpt-4o`, `gpt-4o-mini`, `gpt-3.5-turbo`            | `gpt-4o-mini`  |
| `ANGEL_DEFAULT_PRESET`  | `general`, `interview`, `sales`, `standup`, `brainstorm` | `general` |

These can also be changed at runtime from the dropdowns in the app.

## 3. Set up Google Cloud Speech-to-Text

1. Create a Google Cloud project.
2. Enable the **Speech-to-Text** and **Text-to-Speech** APIs.
3. Create a service account and download the JSON key.
4. Save the JSON file anywhere, then point `GOOGLE_APPLICATION_CREDENTIALS` at it.
   Suggested path: `./gcp-credentials.json` in the project root (already gitignored).

## 4. Run the app

```bash
./start.sh        # or: npm start
```

## 5. Build for production

See `README.md`. The build pipeline reads the same env vars at runtime via the
packaged `.env` is **not** included; set the variables in the user's environment
or bundle a `gcp-credentials.json` as `extraResources` (see `package.json`).

---

## Security notes

- The renderer process runs with `nodeIntegration: false` and `contextIsolation: true`.
  All IPC goes through `preload.js`'s `contextBridge` allowlist.
- A Content-Security-Policy is enforced via `<meta>` in `index.html`.
- **Never** hardcode API keys in source. Earlier versions of this repo did — those
  keys are leaked in git history and on every fork. If you forked or cloned an old
  revision, rotate the keys at <https://platform.openai.com/api-keys> and at
  <https://console.cloud.google.com/iam-admin/serviceaccounts>.
