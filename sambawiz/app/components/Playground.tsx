'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  TextField,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  SelectChangeEvent,
  CircularProgress,
  Alert,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  InputAdornment,
  Link,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import PersonIcon from '@mui/icons-material/Person';
import CodeIcon from '@mui/icons-material/Code';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import CleaningServicesIcon from '@mui/icons-material/CleaningServices';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import CloseIcon from '@mui/icons-material/Close';
import MicIcon from '@mui/icons-material/Mic';
import StopIcon from '@mui/icons-material/Stop';
import AudioFileIcon from '@mui/icons-material/AudioFile';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import ViewCodeDialog from './ViewCodeDialog';
import DocumentationPanel from './DocumentationPanel';

interface Metrics {
  tokensPerSecond: number | null;
  totalLatency: number | null;
  timeToFirstToken: number | null;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  metrics?: Metrics;
  isError?: boolean;
  embeddingData?: number[];
  // Data-URL images attached to a user message (vision models only).
  images?: string[];
  // Data-URL audio rendered as a playable clip: the user's recorded/uploaded
  // clip on an ASR request, or the synthesized clip on a TTS response.
  audioData?: string;
}

// An image staged in the input box before the message is sent. `dataUrl` is a
// base64 data URL suitable both for on-screen preview and for the OpenAI-style
// `image_url` content part sent to the model.
interface AttachedImage {
  id: string;
  name: string;
  dataUrl: string;
}

// An audio clip staged for an ASR (transcription) request — either recorded via
// the mic or picked from a file. `blob` is what we upload; `dataUrl` powers the
// on-screen preview player.
interface StagedAudio {
  name: string;
  dataUrl: string;
  blob: Blob;
}

// qwen3-tts built-in voices and supported languages (from the TTS service spec).
// `voice` is required by /v1/audio/speech; `language` defaults to english.
const TTS_VOICES = ['serena', 'vivian', 'uncle_fu', 'ryan', 'aiden', 'ono_anna', 'sohee', 'eric', 'dylan'];
const TTS_LANGUAGES = [
  'english',
  'chinese',
  'german',
  'french',
  'japanese',
  'korean',
  'italian',
  'portuguese',
  'russian',
  'spanish',
];

export default function Playground() {
  const inputRef = useRef<HTMLInputElement>(null);

  const inputMessageId = 'playground-input-message';
  const keycloakUsernameId = 'playground-keycloak-username';
  const keycloakPasswordId = 'playground-keycloak-password';

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [checkpointMapping, setCheckpointMapping] = useState<Record<string, { model_type?: string; capabilities?: string[] }>>({});

  // Model selection state — the model list comes straight from the current
  // environment's /v1/models endpoint (the routable models), not from any
  // model deployment.
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Images staged for the next message (vision models only).
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Audio staged for the next ASR request (audio models only), plus mic-recording
  // state.
  const [stagedAudio, setStagedAudio] = useState<StagedAudio | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // TTS request options (audio TTS models only).
  const [ttsVoice, setTtsVoice] = useState<string>(TTS_VOICES[0]);
  const [ttsLanguage, setTtsLanguage] = useState<string>(TTS_LANGUAGES[0]);
  const [copiedErrorId, setCopiedErrorId] = useState<string | null>(null);
  const [copiedEmbeddingId, setCopiedEmbeddingId] = useState<string | null>(null);

  // View Code dialog state
  const [viewCodeDialogOpen, setViewCodeDialogOpen] = useState<boolean>(false);
  const [apiKey, setApiKey] = useState<string>('');
  const [apiDomain, setApiDomain] = useState<string>('');
  const [, setCurrentEnvironment] = useState<string>('');

  // API Key Instructions Dialog state
  const [showApiKeyInstructionsDialog, setShowApiKeyInstructionsDialog] = useState<boolean>(false);
  const [keycloakUsername, setKeycloakUsername] = useState<string>('');
  const [keycloakPassword, setKeycloakPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [loadingCredentials, setLoadingCredentials] = useState<boolean>(false);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [uiDomain, setUiDomain] = useState<string>('');

  // API key entry state (for saving the newly created key straight from the dialog)
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [showApiKeyInput, setShowApiKeyInput] = useState<boolean>(false);
  const [savingApiKey, setSavingApiKey] = useState<boolean>(false);
  const [saveApiKeyError, setSaveApiKeyError] = useState<string | null>(null);
  const [saveApiKeySuccess, setSaveApiKeySuccess] = useState<boolean>(false);

  // Fetch the routable models for the current environment from /v1/models.
  const fetchModels = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/models');
      const data = await response.json();

      if (data.success && Array.isArray(data.models)) {
        setAvailableModels(data.models);
        // Preserve the current selection if it's still available, otherwise
        // auto-select the first model.
        setSelectedModel((prev) =>
          prev && data.models.includes(prev) ? prev : (data.models[0] ?? '')
        );
      } else {
        setAvailableModels([]);
        setSelectedModel('');
        setError(data.error || 'Failed to fetch models');
      }
    } catch (err) {
      console.error('Error fetching models:', err);
      setAvailableModels([]);
      setSelectedModel('');
      setError('Failed to connect to the server');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchModels();
    fetchEnvironmentConfig();
    fetch('/api/checkpoint-mapping')
      .then((r) => r.json())
      .then((data) => { if (data.success) setCheckpointMapping(data.data); })
      .catch(() => {});
  }, []);

  // Fetch environment configuration
  const fetchEnvironmentConfig = async () => {
    try {
      const response = await fetch('/api/environments');
      const data = await response.json();

      if (data.success) {
        setCurrentEnvironment(data.defaultEnvironment || '');
        setApiKey(data.defaultApiKey || '');
        setApiDomain(data.defaultApiDomain || '');
        setUiDomain(data.defaultUiDomain || '');
      }
    } catch (err) {
      console.error('Error fetching environment config:', err);
    }
  };

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Restore focus to input after sending completes
  useEffect(() => {
    if (!isSending) {
      inputRef.current?.focus();
    }
  }, [isSending]);

  // Handle model selection
  const handleModelChange = (event: SelectChangeEvent<string>) => {
    const newModel = event.target.value;
    setSelectedModel(newModel);
    // Clear chat history and any staged inputs when switching models
    setMessages([]);
    setAttachedImages([]);
    setImageError(null);
    resetAudioState();
  };

  // Handle clear chat
  const handleClearChat = () => {
    setMessages([]);
    setAttachedImages([]);
    setImageError(null);
    resetAudioState();
  };

  // Stop any in-flight recording and drop the staged clip. Releasing the mic
  // stream tracks turns off the browser's "recording" indicator.
  const resetAudioState = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    recordedChunksRef.current = [];
    setIsRecording(false);
    setStagedAudio(null);
    setAudioError(null);
  };

  // Release the mic stream if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // A model is an embedding model when its checkpoint_mapping capabilities
  // include "embeddings" (the v3 canonical rule; see IsEmbeddingModelFn in
  // types/bundle.ts). /v1/models doesn't distinguish embedding models, so this
  // still comes from the bundle-derived checkpoint mapping. The legacy
  // model_type check is kept as a fallback for older/test data.
  const selectedModelInfo = selectedModel ? checkpointMapping[selectedModel] : undefined;
  const isEmbeddingModel = selectedModelInfo
    ? (selectedModelInfo.capabilities?.includes('embeddings') ?? false) ||
      selectedModelInfo.model_type === 'embedding'
    : false;

  // A model accepts image input when its checkpoint_mapping capabilities include
  // "vision" (see app/data/checkpoint_mapping.json). Only then do we expose the
  // image-attach affordance in the input box.
  const isVisionModel = selectedModelInfo?.capabilities?.includes('vision') ?? false;

  // Audio models carry only the "audio" capability — checkpoint_mapping doesn't
  // sub-type ASR vs TTS — so we split them by name: the qwen3-tts-* models are
  // text→speech (TTS), everything else audio (e.g. Whisper) is speech→text (ASR).
  // The name check also covers the case where /v1/models exposes a routable id
  // (e.g. "qwen3-tts") that isn't itself a checkpoint_mapping key.
  const capsAudio = selectedModelInfo?.capabilities?.includes('audio') ?? false;
  const isTtsModel = /tts/i.test(selectedModel);
  const isAsrModel = (capsAudio && !isTtsModel) || /whisper/i.test(selectedModel);

  // Read a File into a base64 data URL for preview + the model's image_url part.
  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });

  // Cap per-image size to keep the base64 payload (and the request body) sane.
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

  // Handle selecting one or more images from the file picker.
  const handleImageSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    setImageError(null);
    const newImages: AttachedImage[] = [];
    const errors: string[] = [];

    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) {
        errors.push(`${file.name} is not an image`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        errors.push(`${file.name} exceeds the 10 MB limit`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        newImages.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          dataUrl,
        });
      } catch {
        errors.push(`Failed to read ${file.name}`);
      }
    }

    if (newImages.length > 0) {
      setAttachedImages((prev) => [...prev, ...newImages]);
    }
    if (errors.length > 0) {
      setImageError(errors.join('; '));
    }

    // Reset the input so selecting the same file again re-triggers onChange.
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Remove a single staged image.
  const handleRemoveImage = (id: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.id !== id));
  };

  // ---- Audio (ASR) helpers -------------------------------------------------

  // The transcription endpoint caps uploads at 25 MB.
  const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

  const blobToDataUrl = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read audio'));
      reader.readAsDataURL(blob);
    });

  // Pick a file extension the transcription API recognizes from the blob's MIME.
  const extensionForMime = (mimeType: string): string => {
    if (mimeType.includes('webm')) return 'webm';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('flac')) return 'flac';
    return 'webm';
  };

  // Start capturing from the mic. A staged clip is produced in recorder.onstop.
  const startRecording = async () => {
    setAudioError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setAudioError('Audio recording is not supported in this browser');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      recordedChunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(recordedChunksRef.current, { type: mimeType });
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        if (blob.size === 0) {
          setAudioError('No audio was captured');
          return;
        }
        try {
          const dataUrl = await blobToDataUrl(blob);
          setStagedAudio({ name: `recording.${extensionForMime(mimeType)}`, dataUrl, blob });
        } catch {
          setAudioError('Failed to process the recording');
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      setAudioError('Microphone access was denied or is unavailable');
    }
  };

  // Stop the active recording — recorder.onstop stages the resulting clip.
  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  // Stage an audio clip picked from a file instead of the mic.
  const handleAudioFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setAudioError(null);
      if (!file.type.startsWith('audio/')) {
        setAudioError(`${file.name} is not an audio file`);
      } else if (file.size > MAX_AUDIO_BYTES) {
        setAudioError(`${file.name} exceeds the 25 MB limit`);
      } else {
        blobToDataUrl(file)
          .then((dataUrl) => setStagedAudio({ name: file.name, dataUrl, blob: file }))
          .catch(() => setAudioError(`Failed to read ${file.name}`));
      }
    }
    // Reset so selecting the same file again re-triggers onChange.
    if (audioFileInputRef.current) {
      audioFileInputRef.current.value = '';
    }
  };

  // ASR: transcribe the staged audio clip to text via /api/transcribe. The user
  // "message" is the audio itself; the assistant reply is the transcription.
  const handleTranscribeAudio = async () => {
    if (!stagedAudio) return;
    const audio = stagedAudio;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: '',
      timestamp: new Date(),
      audioData: audio.dataUrl,
    };

    setMessages((prev) => [...prev, userMessage]);
    setStagedAudio(null);
    setAudioError(null);
    setIsSending(true);

    try {
      const form = new FormData();
      form.append('file', audio.blob, audio.name);
      form.append('model', selectedModel);

      const response = await fetch('/api/transcribe', { method: 'POST', body: form });
      const data = await response.json();

      if (data.success) {
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: data.text,
            timestamp: new Date(),
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: data.error,
            timestamp: new Date(),
            isError: true,
          },
        ]);
      }
    } catch (err) {
      console.error('Error transcribing audio:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: `Failed to transcribe audio - ${err instanceof Error ? err.message : 'Unknown error'}`,
          timestamp: new Date(),
          isError: true,
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  // Handle send message
  const handleSendMessage = async () => {
    if (!selectedModel) {
      return;
    }

    // ASR models take a recorded/uploaded clip rather than a typed message.
    if (isAsrModel) {
      await handleTranscribeAudio();
      return;
    }

    const hasImages = isVisionModel && attachedImages.length > 0;
    if (!inputMessage.trim() && !hasImages) {
      return;
    }

    const outgoingImages = hasImages ? attachedImages.map((img) => img.dataUrl) : undefined;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputMessage,
      timestamp: new Date(),
      images: outgoingImages,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputMessage('');
    setAttachedImages([]);
    setImageError(null);
    setIsSending(true);

    try {
      if (isEmbeddingModel) {
        // Embeddings: no conversation history, one input at a time
        const response = await fetch('/api/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: inputMessage, model: selectedModel }),
        });

        const data = await response.json();

        if (data.success) {
          const assistantMessage: Message = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: `${data.embedding.length}-dimensional embedding`,
            timestamp: new Date(),
            embeddingData: data.embedding,
          };
          setMessages((prev) => [...prev, assistantMessage]);
        } else {
          const errorMessage: Message = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: data.error,
            timestamp: new Date(),
            isError: true,
          };
          setMessages((prev) => [...prev, errorMessage]);
        }
      } else if (isTtsModel) {
        // TTS: synthesize speech from the typed text; the assistant reply is a
        // playable audio clip (WAV) rather than text.
        const response = await fetch('/api/speech', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: inputMessage, model: selectedModel, voice: ttsVoice, language: ttsLanguage }),
        });

        const data = await response.json();

        if (data.success) {
          const assistantMessage: Message = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: '',
            timestamp: new Date(),
            audioData: data.audio,
          };
          setMessages((prev) => [...prev, assistantMessage]);
        } else {
          const errorMessage: Message = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: data.error,
            timestamp: new Date(),
            isError: true,
          };
          setMessages((prev) => [...prev, errorMessage]);
        }
      } else {
        // Chat: build conversation history. Messages that carry images are sent
        // as OpenAI-style multimodal content parts (text + image_url); plain
        // messages stay as simple strings.
        const updatedMessages = [...messages, userMessage];
        const conversationHistory = [
          { role: 'system', content: 'You are a helpful assistant' },
          ...updatedMessages.map((msg) => {
            if (msg.images && msg.images.length > 0) {
              return {
                role: msg.role,
                content: [
                  ...(msg.content.trim() ? [{ type: 'text', text: msg.content }] : []),
                  ...msg.images.map((url) => ({ type: 'image_url', image_url: { url } })),
                ],
              };
            }
            return { role: msg.role, content: msg.content };
          }),
        ];

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: conversationHistory, model: selectedModel }),
        });

        const data = await response.json();

        if (data.success) {
          const assistantMessage: Message = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: data.content,
            timestamp: new Date(),
            metrics: data.metrics || undefined,
          };
          setMessages((prev) => [...prev, assistantMessage]);
        } else {
          const errorMessage: Message = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: data.error,
            timestamp: new Date(),
            isError: true,
          };
          setMessages((prev) => [...prev, errorMessage]);
        }
      }
    } catch (err) {
      console.error('Error sending message:', err);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Failed to send message - ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: new Date(),
        isError: true,
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsSending(false);
    }
  };

  // Handle copy error to clipboard
  const handleCopyError = (messageId: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedErrorId(messageId);
    setTimeout(() => {
      setCopiedErrorId(null);
    }, 2000);
  };

  // Handle copy embedding array to clipboard
  const handleCopyEmbedding = (messageId: string, embedding: number[]) => {
    navigator.clipboard.writeText(JSON.stringify(embedding));
    setCopiedEmbeddingId(messageId);
    setTimeout(() => {
      setCopiedEmbeddingId(null);
    }, 2000);
  };

  // Handle get API key
  const handleGetApiKey = async () => {
    setShowApiKeyInstructionsDialog(true);
    setLoadingCredentials(true);
    setCredentialsError(null);
    setKeycloakUsername('');
    setKeycloakPassword('');
    setShowPassword(false);
    setApiKeyInput('');
    setShowApiKeyInput(false);
    setSaveApiKeyError(null);
    setSaveApiKeySuccess(false);

    try {
      // Get current environment from bundleDeployments
      const response = await fetch('/api/environments');
      const data = await response.json();

      if (!data.success || !data.defaultEnvironment) {
        setCredentialsError('Please select an environment first');
        setLoadingCredentials(false);
        return;
      }

      const credResponse = await fetch('/api/get-keycloak-credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          environment: data.defaultEnvironment,
        }),
      });

      const credData = await credResponse.json();

      if (credData.success) {
        setKeycloakUsername(credData.username);
        setKeycloakPassword(credData.password);
      } else {
        setCredentialsError(credData.error || 'Failed to retrieve credentials');
      }
    } catch (error) {
      console.error('Error fetching credentials:', error);
      setCredentialsError('Failed to retrieve credentials');
    } finally {
      setLoadingCredentials(false);
    }
  };

  // Save the API key entered in the dialog to app-config.json for the current
  // environment, then keep the user on the Playground with the new key active.
  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) {
      setSaveApiKeyError('Please enter an API key');
      return;
    }

    setSavingApiKey(true);
    setSaveApiKeyError(null);
    setSaveApiKeySuccess(false);

    try {
      const response = await fetch('/api/save-api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
      });

      const data = await response.json();

      if (!data.success) {
        setSaveApiKeyError(data.error || 'Failed to save API key');
        return;
      }

      // Update the in-memory key so subsequent requests use it immediately.
      setApiKey(apiKeyInput.trim());
      setSaveApiKeySuccess(true);
    } catch (error) {
      console.error('Error saving API key:', error);
      setSaveApiKeyError('Failed to save API key');
    } finally {
      setSavingApiKey(false);
    }
  };

  // Handle copy to clipboard
  const handleCopyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // Check if error is related to API key issues
  const isApiKeyError = (errorContent: string): boolean => {
    const lowerContent = errorContent.toLowerCase();
    return lowerContent.includes('unauthorized') ||
           lowerContent.includes('invalid api key') ||
           lowerContent.includes('401') ||
           lowerContent.includes('api key not found in app-config.json');
  };

  // Parse error message to separate header and body
  const parseErrorMessage = (errorContent: string): { header: string; body: string } => {
    // Check if the error follows the pattern "API request failed: STATUS - DETAILS"
    // Look for " - " separator
    const dashIndex = errorContent.indexOf(' - ');

    if (dashIndex !== -1) {
      const potentialHeader = errorContent.substring(0, dashIndex).trim();
      const potentialBody = errorContent.substring(dashIndex + 3).trim();

      // If we found a separator and the header looks like an error status line
      if (potentialHeader && potentialBody &&
          (potentialHeader.startsWith('API request failed:') ||
           potentialHeader.startsWith('Failed to') ||
           potentialHeader.includes('Error'))) {
        return {
          header: potentialHeader,
          body: potentialBody,
        };
      }
    }

    // For other error formats, check if it starts with a recognizable error pattern
    if (errorContent.startsWith('API request failed:')) {
      // Extract just the status line as header
      const statusMatch = errorContent.match(/^(API request failed: \d+ [A-Z\s]+)/);
      if (statusMatch) {
        const header = statusMatch[1];
        const remainingText = errorContent.substring(header.length).trim();
        return {
          header: header,
          body: remainingText || 'No additional details provided',
        };
      }
    }

    // Fallback: use "Error" as header and full content as body
    return {
      header: 'Error',
      body: errorContent,
    };
  };

  // Handle manual refresh — re-fetch the routable models from /v1/models.
  const handleRefresh = async () => {
    setMessages([]);
    await fetchModels();
    fetchEnvironmentConfig();
  };

  // Handle Enter key press
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <Box>
      {/* Documentation Panel */}
      <DocumentationPanel docFile="playground.md" />

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          Playground
        </Typography>
        <Button
          variant="outlined"
          size="small"
          startIcon={loading ? <CircularProgress size={16} /> : <RefreshIcon />}
          onClick={handleRefresh}
          disabled={loading}
          sx={{ textTransform: 'none' }}
        >
          Refresh
        </Button>
      </Box>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Chat with your deployed models
      </Typography>

      {/* Main Playground Container */}
      <Paper
        elevation={0}
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 2,
          overflow: 'hidden',
          height: 'calc(100vh - 250px)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header with Model Selector */}
        <Box
          sx={{
            p: 2,
            borderBottom: '1px solid',
            borderColor: 'divider',
            backgroundColor: 'grey.50',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            flexWrap: 'wrap',
          }}
        >
          <FormControl sx={{ minWidth: 300 }} size="small">
            <InputLabel id="model-select-label">Select Model</InputLabel>
            <Select
              labelId="model-select-label"
              id="model-select"
              value={selectedModel}
              onChange={handleModelChange}
              label="Select Model"
              disabled={loading || availableModels.length === 0}
              sx={{ backgroundColor: 'white' }}
            >
              {availableModels.map((model) => (
                <MenuItem key={model} value={model}>
                  {model}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {selectedModel && (
            <>
              <Button
                variant="outlined"
                size="small"
                startIcon={<CodeIcon />}
                onClick={() => setViewCodeDialogOpen(true)}
                sx={{
                  backgroundColor: 'white',
                  textTransform: 'none',
                }}
              >
                View Code
              </Button>
              <Button
                variant="outlined"
                size="small"
                startIcon={<CleaningServicesIcon />}
                onClick={handleClearChat}
                disabled={messages.length === 0}
                sx={{
                  backgroundColor: 'white',
                  textTransform: 'none',
                }}
              >
                Clear Chat
              </Button>
            </>
          )}

          {loading && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={20} />
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Loading models...
              </Typography>
            </Box>
          )}
        </Box>

        {/* Error State */}
        {error && (
          <Box sx={{ p: 2 }}>
            <Alert severity="error">{error}</Alert>
          </Box>
        )}

        {/* No Models State */}
        {!loading && availableModels.length === 0 && !error && (
          <Box sx={{ p: 3 }}>
            <Alert severity="info">
              No models available for this environment. Deploy a bundle (and make sure its models are
              routable) to use the playground.
            </Alert>
          </Box>
        )}

        {/* Chat Interface - Only show when a model is selected */}
        {selectedModel && (
          <>
            {/* Messages Container */}
            <Box
              sx={{
                flex: 1,
                overflowY: 'auto',
                p: 3,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                backgroundColor: '#fafafa',
              }}
            >
              {messages.length === 0 ? (
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: 'text.secondary',
                  }}
                >
                  <SmartToyIcon sx={{ fontSize: 60, mb: 2, opacity: 0.3 }} />
                  <Typography variant="h6" sx={{ mb: 1 }}>
                    {isEmbeddingModel
                      ? 'Generate embeddings'
                      : isAsrModel
                        ? 'Transcribe speech'
                        : isTtsModel
                          ? 'Synthesize speech'
                          : 'Start a conversation'}
                  </Typography>
                  <Typography variant="body2">
                    {isEmbeddingModel
                      ? <>Enter text to embed with <strong>{selectedModel}</strong></>
                      : isAsrModel
                        ? <>Record or upload audio to transcribe with <strong>{selectedModel}</strong></>
                        : isTtsModel
                          ? <>Enter text to speak with <strong>{selectedModel}</strong></>
                          : isVisionModel
                            ? <>Chatting with <strong>{selectedModel}</strong> — attach an image and ask about it</>
                            : <>Chatting with <strong>{selectedModel}</strong></>
                    }
                  </Typography>
                </Box>
              ) : (
                <>
                  {messages.map((message) => (
                    <Box
                      key={message.id}
                      sx={{
                        display: 'flex',
                        gap: 2,
                        alignItems: 'flex-start',
                        flexDirection: message.role === 'user' ? 'row-reverse' : 'row',
                      }}
                    >
                      {/* Avatar */}
                      <Box
                        sx={{
                          width: 36,
                          height: 36,
                          borderRadius: '50%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          backgroundColor: message.role === 'user' ? 'primary.main' : '#e0e0e0',
                          color: message.role === 'user' ? 'white' : 'text.primary',
                        }}
                      >
                        {message.role === 'user' ? (
                          <PersonIcon sx={{ fontSize: 20 }} />
                        ) : (
                          <Box
                            component="img"
                            src="/icon.svg"
                            alt="AI Assistant"
                            sx={{
                              width: 24,
                              height: 24,
                            }}
                          />
                        )}
                      </Box>

                      {/* Message Content */}
                      <Box sx={{ maxWidth: '70%' }}>
                        {message.isError ? (
                          // Error Box with special styling
                          (() => {
                            const { header, body } = parseErrorMessage(message.content);
                            return (
                              <Box
                                sx={{
                                  border: '1px solid',
                                  borderColor: 'error.main',
                                  borderRadius: 2,
                                  backgroundColor: '#fff5f5',
                                  overflow: 'hidden',
                                }}
                              >
                                <Box
                                  sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    backgroundColor: '#ffebee',
                                    px: 2,
                                    py: 1,
                                    borderBottom: '1px solid',
                                    borderColor: 'error.light',
                                  }}
                                >
                                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1 }}>
                                    <ErrorOutlineIcon sx={{ fontSize: 20, color: 'error.main' }} />
                                    <Typography
                                      variant="subtitle2"
                                      sx={{ color: 'error.main', fontWeight: 600 }}
                                    >
                                      {header}
                                    </Typography>
                                  </Box>
                                  <IconButton
                                    size="small"
                                    onClick={() => handleCopyError(message.id, message.content)}
                                    sx={{
                                      color: copiedErrorId === message.id ? 'success.main' : 'text.secondary',
                                    }}
                                  >
                                    <ContentCopyIcon sx={{ fontSize: 18 }} />
                                  </IconButton>
                                </Box>
                                <Box sx={{ p: 2 }}>
                                  <Typography
                                    variant="body2"
                                    sx={{
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-word',
                                      color: 'text.primary',
                                      fontFamily: 'monospace',
                                      fontSize: '0.875rem',
                                    }}
                                  >
                                    {body}
                                  </Typography>

                                  {/* Show remedial message for API key errors */}
                                  {isApiKeyError(message.content) && (
                                    <Box
                                      sx={{
                                        mt: 2,
                                        pt: 2,
                                        borderTop: '1px solid',
                                        borderColor: 'error.light',
                                      }}
                                    >
                                      <Typography
                                        variant="body2"
                                        sx={{
                                          color: 'text.primary',
                                          mb: 1,
                                        }}
                                      >
                                        This error may be caused by an invalid or missing API key.
                                      </Typography>
                                      <Typography
                                        variant="body2"
                                        sx={{
                                          color: 'text.primary',
                                        }}
                                      >
                                        Please update your API key by clicking{' '}
                                        <Link
                                          component="button"
                                          onClick={handleGetApiKey}
                                          sx={{
                                            color: 'primary.main',
                                            cursor: 'pointer',
                                            textDecoration: 'underline',
                                            '&:hover': {
                                              color: 'primary.dark',
                                            },
                                          }}
                                        >
                                          this link
                                        </Link>
                                        .
                                      </Typography>
                                    </Box>
                                  )}

                                  <Typography
                                    variant="caption"
                                    sx={{
                                      display: 'block',
                                      mt: 1.5,
                                      color: 'text.secondary',
                                    }}
                                  >
                                    {message.timestamp.toLocaleTimeString()}
                                  </Typography>
                                </Box>
                              </Box>
                            );
                          })()
                        ) : message.embeddingData ? (
                          // Embedding Response Box
                          <Box
                            sx={{
                              p: 2,
                              borderRadius: 2,
                              backgroundColor: 'white',
                              boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                              minWidth: 280,
                            }}
                          >
                            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                              <Typography variant="subtitle2" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                                {message.embeddingData.length}-dimensional embedding
                              </Typography>
                              <IconButton
                                size="small"
                                onClick={() => handleCopyEmbedding(message.id, message.embeddingData!)}
                                sx={{ color: copiedEmbeddingId === message.id ? 'success.main' : 'text.secondary' }}
                                title={copiedEmbeddingId === message.id ? 'Copied!' : 'Copy array'}
                              >
                                <ContentCopyIcon sx={{ fontSize: 16 }} />
                              </IconButton>
                            </Box>
                            <Typography
                              variant="body2"
                              sx={{
                                fontFamily: 'monospace',
                                fontSize: '0.75rem',
                                color: 'text.secondary',
                                wordBreak: 'break-all',
                                backgroundColor: 'grey.50',
                                borderRadius: 1,
                                p: 1,
                              }}
                            >
                              [{message.embeddingData.slice(0, 8).map((v) => v.toFixed(8)).join(', ')}, ...]
                            </Typography>
                            <Typography
                              variant="caption"
                              sx={{ display: 'block', mt: 1, opacity: 0.7 }}
                            >
                              {message.timestamp.toLocaleTimeString()}
                            </Typography>
                          </Box>
                        ) : (
                          // Normal Message Box
                          <Box
                            sx={{
                              p: 2,
                              borderRadius: 2,
                              backgroundColor: message.role === 'user' ? 'primary.main' : 'white',
                              color: message.role === 'user' ? 'white' : 'text.primary',
                              boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                            }}
                          >
                            {message.images && message.images.length > 0 && (
                              <Box
                                sx={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: 1,
                                  mb: message.content.trim() ? 1 : 0,
                                }}
                              >
                                {message.images.map((src, idx) => (
                                  <Box
                                    key={idx}
                                    component="img"
                                    src={src}
                                    alt={`Attached image ${idx + 1}`}
                                    sx={{
                                      maxWidth: 200,
                                      maxHeight: 200,
                                      borderRadius: 1,
                                      display: 'block',
                                    }}
                                  />
                                ))}
                              </Box>
                            )}
                            {message.audioData && (
                              <Box
                                component="audio"
                                controls
                                src={message.audioData}
                                sx={{
                                  display: 'block',
                                  width: 260,
                                  maxWidth: '100%',
                                  mb: message.content.trim() ? 1 : 0,
                                }}
                              />
                            )}
                            {message.content.trim() && (
                              <Typography
                                variant="body1"
                                sx={{
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                }}
                              >
                                {message.content}
                              </Typography>
                            )}
                            <Typography
                              variant="caption"
                              sx={{
                                display: 'block',
                                mt: 1,
                                opacity: 0.7,
                              }}
                            >
                              {message.timestamp.toLocaleTimeString()}
                            </Typography>
                          </Box>
                        )}

                        {/* Metrics Panel - Only for assistant messages with metrics */}
                        {message.role === 'assistant' && message.metrics && (
                          <Box
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                              mt: 1,
                              px: 1.5,
                              py: 0.75,
                              backgroundColor: 'rgba(0, 0, 0, 0.03)',
                              borderRadius: 1,
                              fontSize: '0.75rem',
                              color: 'text.secondary',
                            }}
                          >
                            <RocketLaunchIcon sx={{ fontSize: 14, color: 'primary.main' }} />
                            {message.metrics.tokensPerSecond !== null && (
                              <>
                                <Typography variant="caption" sx={{ fontSize: '0.75rem' }}>
                                  {message.metrics.tokensPerSecond.toFixed(1)} t/s
                                </Typography>
                                <Typography variant="caption" sx={{ fontSize: '0.75rem', mx: 0.5 }}>
                                  |
                                </Typography>
                              </>
                            )}
                            {message.metrics.totalLatency !== null && (
                              <>
                                <Typography variant="caption" sx={{ fontSize: '0.75rem' }}>
                                  {message.metrics.totalLatency.toFixed(2)}s
                                </Typography>
                                <Typography variant="caption" sx={{ fontSize: '0.75rem', mx: 0.5 }}>
                                  |
                                </Typography>
                              </>
                            )}
                            {message.metrics.timeToFirstToken !== null && (
                              <Typography variant="caption" sx={{ fontSize: '0.75rem' }}>
                                {message.metrics.timeToFirstToken.toFixed(2)}s to first token
                              </Typography>
                            )}
                          </Box>
                        )}
                      </Box>
                    </Box>
                  ))}
                  {isSending && (
                    <Box
                      sx={{
                        display: 'flex',
                        gap: 2,
                        alignItems: 'flex-start',
                      }}
                    >
                      <Box
                        sx={{
                          width: 36,
                          height: 36,
                          borderRadius: '50%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          backgroundColor: '#e0e0e0',
                        }}
                      >
                        <Box
                          component="img"
                          src="/icon.svg"
                          alt="AI Assistant"
                          sx={{
                            width: 24,
                            height: 24,
                          }}
                        />
                      </Box>
                      <Box
                        sx={{
                          p: 2,
                          borderRadius: 2,
                          backgroundColor: 'white',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                        }}
                      >
                        <CircularProgress size={20} />
                      </Box>
                    </Box>
                  )}
                  <div ref={messagesEndRef} />
                </>
              )}
            </Box>

            {/* Input Section */}
            <Box
              sx={{
                p: 2,
                borderTop: '1px solid',
                borderColor: 'divider',
                backgroundColor: 'white',
              }}
            >
              {/* Image error */}
              {isVisionModel && imageError && (
                <Alert severity="error" sx={{ mb: 1 }} onClose={() => setImageError(null)}>
                  {imageError}
                </Alert>
              )}

              {/* Staged image previews */}
              {isVisionModel && attachedImages.length > 0 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
                  {attachedImages.map((img) => (
                    <Box
                      key={img.id}
                      sx={{
                        position: 'relative',
                        width: 64,
                        height: 64,
                        borderRadius: 1,
                        overflow: 'hidden',
                        border: '1px solid',
                        borderColor: 'divider',
                      }}
                    >
                      <Box
                        component="img"
                        src={img.dataUrl}
                        alt={img.name}
                        sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                      <IconButton
                        size="small"
                        onClick={() => handleRemoveImage(img.id)}
                        disabled={isSending}
                        sx={{
                          position: 'absolute',
                          top: 2,
                          right: 2,
                          p: '2px',
                          backgroundColor: 'rgba(0,0,0,0.6)',
                          color: 'white',
                          '&:hover': { backgroundColor: 'rgba(0,0,0,0.8)' },
                        }}
                      >
                        <CloseIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Box>
                  ))}
                </Box>
              )}

              {/* Audio (ASR) error */}
              {isAsrModel && audioError && (
                <Alert severity="error" sx={{ mb: 1 }} onClose={() => setAudioError(null)}>
                  {audioError}
                </Alert>
              )}

              {/* Staged audio preview (ASR) */}
              {isAsrModel && stagedAudio && (
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    mb: 1,
                    p: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 2,
                  }}
                >
                  <Box component="audio" controls src={stagedAudio.dataUrl} sx={{ height: 36, flex: 1, minWidth: 0 }} />
                  <IconButton
                    size="small"
                    onClick={() => setStagedAudio(null)}
                    disabled={isSending}
                    title="Remove audio"
                  >
                    <CloseIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Box>
              )}

              {/* TTS voice + language options */}
              {isTtsModel && (
                <Box sx={{ display: 'flex', gap: 1, mb: 1, flexWrap: 'wrap' }}>
                  <FormControl size="small" sx={{ minWidth: 140 }}>
                    <InputLabel id="tts-voice-label">Voice</InputLabel>
                    <Select
                      labelId="tts-voice-label"
                      label="Voice"
                      value={ttsVoice}
                      onChange={(e) => setTtsVoice(e.target.value)}
                      disabled={isSending}
                    >
                      {TTS_VOICES.map((voice) => (
                        <MenuItem key={voice} value={voice}>{voice}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl size="small" sx={{ minWidth: 140 }}>
                    <InputLabel id="tts-language-label">Language</InputLabel>
                    <Select
                      labelId="tts-language-label"
                      label="Language"
                      value={ttsLanguage}
                      onChange={(e) => setTtsLanguage(e.target.value)}
                      disabled={isSending}
                    >
                      {TTS_LANGUAGES.map((language) => (
                        <MenuItem key={language} value={language}>{language}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Box>
              )}

              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
                {/* Record / attach audio — only for ASR models */}
                {isAsrModel && (
                  <>
                    <input
                      ref={audioFileInputRef}
                      type="file"
                      accept="audio/*"
                      hidden
                      onChange={handleAudioFileSelect}
                    />
                    <IconButton
                      color={isRecording ? 'error' : 'primary'}
                      onClick={isRecording ? stopRecording : startRecording}
                      disabled={isSending}
                      title={isRecording ? 'Stop recording' : 'Record audio'}
                      sx={{
                        height: 40,
                        width: 40,
                        border: '1px solid',
                        borderColor: isRecording ? 'error.main' : 'divider',
                        borderRadius: 2,
                      }}
                    >
                      {isRecording ? <StopIcon /> : <MicIcon />}
                    </IconButton>
                    <IconButton
                      color="primary"
                      onClick={() => audioFileInputRef.current?.click()}
                      disabled={isSending || isRecording}
                      title="Upload audio file"
                      sx={{
                        height: 40,
                        width: 40,
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 2,
                      }}
                    >
                      <AudioFileIcon />
                    </IconButton>
                    <Box
                      sx={{
                        flex: 1,
                        height: 40,
                        display: 'flex',
                        alignItems: 'center',
                        px: 1.5,
                        color: 'text.secondary',
                        border: '1px dashed',
                        borderColor: 'divider',
                        borderRadius: 2,
                        fontSize: '0.875rem',
                      }}
                    >
                      {isRecording
                        ? 'Recording… click stop when done'
                        : stagedAudio
                          ? 'Audio ready — press send to transcribe'
                          : 'Record or upload audio to transcribe'}
                    </Box>
                  </>
                )}
                {/* Attach image — only for vision-capable models */}
                {isVisionModel && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={handleImageSelect}
                    />
                    <IconButton
                      color="primary"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isSending}
                      title="Attach image"
                      sx={{
                        height: 40,
                        width: 40,
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 2,
                      }}
                    >
                      <AddPhotoAlternateIcon />
                    </IconButton>
                  </>
                )}
                {!isAsrModel && (
                  <TextField
                    id={inputMessageId}
                    fullWidth
                    multiline
                    maxRows={4}
                    placeholder={
                      isEmbeddingModel
                        ? 'Enter text to embed...'
                        : isTtsModel
                          ? 'Enter text to speak...'
                          : isVisionModel
                            ? 'Ask a question about your image...'
                            : 'Type your message...'
                    }
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={isSending}
                    inputRef={inputRef}
                    variant="outlined"
                    size="small"
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        borderRadius: 2,
                      },
                    }}
                  />
                )}
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handleSendMessage}
                  disabled={
                    isSending ||
                    (isAsrModel
                      ? !stagedAudio || isRecording
                      : !inputMessage.trim() && attachedImages.length === 0)
                  }
                  sx={{
                    minWidth: 50,
                    height: 40,
                    borderRadius: 2,
                  }}
                >
                  <SendIcon />
                </Button>
              </Box>
              <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
                {isAsrModel
                  ? 'Record with the mic or upload an audio file, then press send to transcribe'
                  : isTtsModel
                    ? 'Choose a voice and language, type text, then press send to synthesize speech'
                    : (
                        <>
                          Press Enter to send, Shift+Enter for new line
                          {isVisionModel && ' — attach images with the image button'}
                        </>
                      )}
              </Typography>
            </Box>
          </>
        )}

        {/* Prompt to select a model when models are available but none is selected */}
        {!selectedModel && !loading && !error && availableModels.length > 0 && (
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              p: 4,
              color: 'text.secondary',
            }}
          >
            <SmartToyIcon sx={{ fontSize: 80, mb: 2, opacity: 0.2 }} />
            <Typography variant="h6" sx={{ mb: 1 }}>
              Select a model to get started
            </Typography>
            <Typography variant="body2">
              Choose a model from the dropdown above
            </Typography>
          </Box>
        )}
      </Paper>

      {/* View Code Dialog */}
      <ViewCodeDialog
        open={viewCodeDialogOpen}
        onClose={() => setViewCodeDialogOpen(false)}
        apiKey={apiKey}
        apiDomain={apiDomain}
        modelName={selectedModel}
        isEmbedding={isEmbeddingModel}
        isAsr={isAsrModel}
        isTts={isTtsModel}
        ttsVoice={ttsVoice}
        ttsLanguage={ttsLanguage}
      />

      {/* API Key Instructions Dialog */}
      <Dialog
        open={showApiKeyInstructionsDialog}
        onClose={() => setShowApiKeyInstructionsDialog(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>API Key Instructions</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 3 }}>
            Login to the following UI domain using the following credentials to create your API key
          </DialogContentText>

          {/* Loading State */}
          {loadingCredentials && (
            <Box sx={{ display: 'flex', justifyContent: 'center', my: 3 }}>
              <CircularProgress size={40} />
            </Box>
          )}

          {/* Error State */}
          {credentialsError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {credentialsError}
            </Alert>
          )}

          {/* UI Domain */}
          {!loadingCredentials && uiDomain && (
            <Box sx={{ mb: 3 }}>
              <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                UI Domain:
              </Typography>
              <Typography
                component="a"
                href={uiDomain}
                target="_blank"
                rel="noopener noreferrer"
                sx={{
                  color: 'primary.main',
                  textDecoration: 'underline',
                  wordBreak: 'break-all',
                  '&:hover': {
                    color: 'primary.dark',
                  },
                }}
              >
                {uiDomain}
              </Typography>
            </Box>
          )}

          {/* Credentials */}
          {!loadingCredentials && keycloakUsername && keycloakPassword && (
            <Box>
              {/* Username */}
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                  Username:
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <TextField
                    id={keycloakUsernameId}
                    fullWidth
                    value={keycloakUsername}
                    variant="outlined"
                    size="small"
                    slotProps={{
                      input: {
                        readOnly: true,
                      },
                    }}
                  />
                  <IconButton
                    onClick={() => handleCopyToClipboard(keycloakUsername)}
                    size="small"
                    sx={{ color: 'primary.main' }}
                  >
                    <ContentCopyIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>

              {/* Password */}
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                  Password:
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <TextField
                    id={keycloakPasswordId}
                    fullWidth
                    type={showPassword ? 'text' : 'password'}
                    value={keycloakPassword}
                    variant="outlined"
                    size="small"
                    slotProps={{
                      input: {
                        readOnly: true,
                        endAdornment: (
                          <InputAdornment position="end">
                            <IconButton
                              onClick={() => setShowPassword(!showPassword)}
                              edge="end"
                              size="small"
                            >
                              {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                            </IconButton>
                          </InputAdornment>
                        ),
                      },
                    }}
                  />
                  <IconButton
                    onClick={() => handleCopyToClipboard(keycloakPassword)}
                    size="small"
                    sx={{ color: 'primary.main' }}
                  >
                    <ContentCopyIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>
            </Box>
          )}

          {!loadingCredentials && !uiDomain && (
            <Alert severity="warning">
              Please select an environment with a UI domain configured.
            </Alert>
          )}

          {/* API Key entry — paste the key created via the instructions above and
              save it without leaving the Playground. */}
          {!loadingCredentials && (
            <Box sx={{ mt: 3, pt: 3, borderTop: '1px solid', borderColor: 'divider' }}>
              <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                Paste your API key:
              </Typography>
              <TextField
                fullWidth
                type={showApiKeyInput ? 'text' : 'password'}
                value={apiKeyInput}
                onChange={(e) => {
                  setApiKeyInput(e.target.value);
                  setSaveApiKeySuccess(false);
                  setSaveApiKeyError(null);
                }}
                placeholder="Enter your API key"
                variant="outlined"
                size="small"
                disabled={savingApiKey}
                slotProps={{
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          onClick={() => setShowApiKeyInput(!showApiKeyInput)}
                          edge="end"
                          size="small"
                        >
                          {showApiKeyInput ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
              />
              {saveApiKeyError && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  {saveApiKeyError}
                </Alert>
              )}
              {saveApiKeySuccess && (
                <Alert severity="success" sx={{ mt: 2 }}>
                  API key saved successfully!
                </Alert>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowApiKeyInstructionsDialog(false)}>
            Close
          </Button>
          <Button
            onClick={handleSaveApiKey}
            variant="contained"
            disabled={savingApiKey || !apiKeyInput.trim()}
            startIcon={savingApiKey ? <CircularProgress size={16} color="inherit" /> : null}
          >
            {savingApiKey ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
