# Playground Page

## Overview

The Playground page provides an interactive chat interface to test and interact with your deployed models. It allows you to send prompts to models and see their responses along with performance metrics.

## What Happens on This Page

1. **Select Model**: Pick from the models that are routable in the current environment (fetched from the `/v1/models` API)
2. **Chat Interface**: Send messages and receive responses from the model
3. **Performance Metrics**: View tokens/second, total latency, and time to first token
4. **View Code**: Get code snippets for integrating with the API

## Where the Model List Comes From

The Playground does **not** use kubectl or the model deployment to list models. Instead, it calls the environment's OpenAI-compatible `/v1/models` endpoint, which returns exactly the models that are routable (i.e. the ones you can actually send requests to). This avoids showing models that exist in a bundle but aren't served.

### List Models
```
GET <apiDomain>/v1/models
Headers:
  Authorization: Bearer <apiKey>
```
**Purpose**: Retrieves the routable models for the current environment to populate the model selector
**When**: On page load and on Refresh
**Configuration**: Uses the API Domain and API Key from your current environment (set on the Home page)

### Embedding vs. Chat Models

`/v1/models` does not indicate whether a model is an embedding model. The Playground determines this from the local `checkpoint_mapping` (a model is an embedding model when its `capabilities` include `"embeddings"`). Embedding models use the `/v1/embeddings` endpoint; all other models use `/v1/chat/completions`.

### Vision (Image) Models

When the selected model's `capabilities` in the local `checkpoint_mapping` include `"vision"`, the Playground shows an image-attach button next to the message box. You can attach one or more images (each up to 10 MB) and ask a question about them. Attached images are sent as OpenAI-style multimodal content parts alongside the text:

```
{
  "role": "user",
  "content": [
    {"type": "text", "text": "What is in this image?"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
  ]
}
```

The image button is hidden for text-only and embedding models.

### Audio Models (ASR & TTS)

Audio models carry only the `"audio"` capability in `checkpoint_mapping` — it doesn't sub-type ASR vs TTS — so the Playground splits them by name: models whose id contains `tts` (e.g. `qwen3-tts`) are **text-to-speech**; other audio models (e.g. `Whisper-Large-v3`) are **speech-to-text**. The name check also handles the case where `/v1/models` exposes a routable id (like `qwen3-tts`) that isn't itself a `checkpoint_mapping` key.

**ASR — speech to text (Whisper).** The input box is replaced with a **mic record button** and an **audio-file upload button**. Record a clip (or upload one, ≤ 25 MB), then press send; the clip is posted as `multipart/form-data` and the transcription comes back as the assistant reply.

```
POST <apiDomain>/v1/audio/transcriptions        (multipart/form-data)
  file=<audio blob>   model=Whisper-Large-v3   [language, prompt, response_format]
→ { "text": "…transcription…" }
```

Supported upload formats: FLAC, MP3, MP4, MPEG, MPGA, M4A, Ogg, WAV, WebM. Mic recordings are captured via the browser `MediaRecorder` API (typically WebM/Opus).

**TTS — text to speech (qwen3-tts).** A **Voice** and **Language** selector appear above the message box. Type text and press send; the synthesized clip is returned as a playable `<audio>` element.

```
POST <apiDomain>/v1/audio/speech                (application/json)
  { "model": "qwen3-tts-talker", "input": "…", "voice": "vivian", "language": "english" }
→ Server-Sent Events: one { "audio_b64": "<base64 float32 PCM @ 24kHz>", … } per ~1s
  chunk, terminated by `data: [DONE]`
```

`voice` is required (one of: serena, vivian, uncle_fu, ryan, aiden, ono_anna, sohee, eric, dylan). By default the `model` field is the routable model id selected in the picker (e.g. `qwen3-tts-talker`). The `/api/speech` route aggregates the streamed float32 PCM chunks and wraps them in a WAV container so the browser can play the whole clip in one `<audio>` element.

**`ttsModel` override.** The routable id from `/v1/models` (e.g. `qwen3-tts-talker`) can differ from the id the `/v1/audio/speech` handler is configured to accept (the spec example uses `qwen3-tts`). When they don't match you'll see either a gateway `404 … model does not exist` (id isn't routable) or a handler `400 Unsupported model … on /audio/speech API` (id is routable but the handler rejects it). Set a `ttsModel` on the environment in `app-config.json` (or a top-level `ttsModel` as a global fallback) to send a fixed model id to `/v1/audio/speech` independent of the picker. Note: the value you set must also be routable by the gateway — if neither the routable id nor the handler-expected id is both routable *and* accepted, the platform/deployment needs to align them (this can't be resolved from the client alone).

## Chat Functionality

The Playground uses the SambaStack API for inference. The API calls use:
- **API Domain**: Configured on the Home page (e.g., `https://api.example.com`)
- **API Key**: Configured on the Home page for authentication
- **Model Name**: Selected from the dropdown (e.g., `Meta-Llama-3.3-70B-Instruct`)

### API Request Format
```
POST <apiDomain>/v1/chat/completions
Headers:
  Authorization: Bearer <apiKey>
  Content-Type: application/json
Body:
  {
    "model": "<selected-model>",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant"},
      {"role": "user", "content": "<user-message>"},
      ...
    ]
  }
```

## Performance Metrics

The Playground displays the following metrics for each response:

- **Tokens/second**: Generation speed (higher is better)
- **Total Latency**: End-to-end response time in seconds
- **Time to First Token**: Latency before the first token is generated (lower is better)

## View Code Dialog

The "View Code" button shows Python and cURL examples for:
1. Calling the chat completions API
2. Using your configured API key and domain
3. Sending messages to the selected model

This helps developers integrate the deployed models into their applications.
