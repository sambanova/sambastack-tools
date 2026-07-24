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
