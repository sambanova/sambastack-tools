'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
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
}

export default function Playground() {
  const router = useRouter();

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
    // Clear chat history when switching models
    setMessages([]);
  };

  // Handle clear chat
  const handleClearChat = () => {
    setMessages([]);
  };

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

  // Handle send message
  const handleSendMessage = async () => {
    if (!inputMessage.trim() || !selectedModel) {
      return;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputMessage,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputMessage('');
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
      } else {
        // Chat: build conversation history
        const updatedMessages = [...messages, userMessage];
        const conversationHistory = [
          { role: 'system', content: 'You are a helpful assistant' },
          ...updatedMessages.map((msg) => ({ role: msg.role, content: msg.content })),
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
                    {isEmbeddingModel ? 'Generate embeddings' : 'Start a conversation'}
                  </Typography>
                  <Typography variant="body2">
                    {isEmbeddingModel
                      ? <>Enter text to embed with <strong>{selectedModel}</strong></>
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
                                        Please{' '}
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
                                          get your API key
                                        </Link>
                                        {' '}and update it on the Home page.
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
                            <Typography
                              variant="body1"
                              sx={{
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                              }}
                            >
                              {message.content}
                            </Typography>
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
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
                <TextField
                  id={inputMessageId}
                  fullWidth
                  multiline
                  maxRows={4}
                  placeholder={isEmbeddingModel ? 'Enter text to embed...' : 'Type your message...'}
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
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handleSendMessage}
                  disabled={!inputMessage.trim() || isSending}
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
                Press Enter to send, Shift+Enter for new line
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
        </DialogContent>
        <DialogActions>
          <Button onClick={() => {
            setShowApiKeyInstructionsDialog(false);
            router.push('/');
          }} autoFocus>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
