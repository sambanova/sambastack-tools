'use client';

import { useState, useEffect, useRef, useId } from 'react';
import { useRouter } from 'next/navigation';
import {
  Send,
  Bot,
  User,
  Code2,
  Rocket,
  Eraser,
  Copy,
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { getBundleDeploymentStatus } from './BundleDeploymentManager';
import ViewCodeDialog from './ViewCodeDialog';
import DocumentationPanel from './DocumentationPanel';

interface BundleDeployment {
  name: string;
  namespace: string;
  bundle: string;
  creationTimestamp: string;
}

interface PodStatusInfo {
  ready: number;
  total: number;
  status: string;
}

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const keycloakUsernameId = useId();
  const keycloakPasswordId = useId();

  const [bundleDeployments, setBundleDeployments] = useState<BundleDeployment[]>([]);
  const [selectedDeployment, setSelectedDeployment] = useState<string>('');
  const [deploymentStatuses, setDeploymentStatuses] = useState<
    Record<string, { cachePod: PodStatusInfo | null; defaultPod: PodStatusInfo | null }>
  >({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [checkpointMapping, setCheckpointMapping] = useState<
    Record<string, { model_type?: string }>
  >({});

  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [loadingModels, setLoadingModels] = useState<boolean>(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);
  const [copiedErrorId, setCopiedErrorId] = useState<string | null>(null);
  const [copiedEmbeddingId, setCopiedEmbeddingId] = useState<string | null>(null);

  const [viewCodeDialogOpen, setViewCodeDialogOpen] = useState<boolean>(false);
  const [apiKey, setApiKey] = useState<string>('');
  const [apiDomain, setApiDomain] = useState<string>('');
  const [, setCurrentEnvironment] = useState<string>('');

  const [showApiKeyInstructionsDialog, setShowApiKeyInstructionsDialog] =
    useState<boolean>(false);
  const [keycloakUsername, setKeycloakUsername] = useState<string>('');
  const [keycloakPassword, setKeycloakPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [loadingCredentials, setLoadingCredentials] = useState<boolean>(false);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [uiDomain, setUiDomain] = useState<string>('');

  const fetchBundleDeployments = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/bundle-deployment');
      const data = await response.json();
      if (data.success) {
        setBundleDeployments(data.bundleDeployments);
        const statuses: Record<
          string,
          { cachePod: PodStatusInfo | null; defaultPod: PodStatusInfo | null }
        > = {};
        await Promise.all(
          data.bundleDeployments.map(async (deployment: BundleDeployment) => {
            try {
              const statusResponse = await fetch(
                `/api/pod-status?deploymentName=${deployment.name}`
              );
              const statusData = await statusResponse.json();
              statuses[deployment.name] = statusData.success
                ? statusData.podStatus
                : { cachePod: null, defaultPod: null };
            } catch {
              statuses[deployment.name] = { cachePod: null, defaultPod: null };
            }
          })
        );
        setDeploymentStatuses(statuses);
      } else {
        setError(data.error || 'Failed to fetch bundle deployments');
      }
    } catch (err) {
      setError('Failed to connect to the server');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

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

  useEffect(() => {
    fetchBundleDeployments();
    fetchEnvironmentConfig();
    fetch('/api/checkpoint-mapping')
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setCheckpointMapping(data.data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!isSending) inputRef.current?.focus();
  }, [isSending]);

  // Auto-select single deployed bundle
  useEffect(() => {
    if (selectedDeployment) return;
    const deployed = bundleDeployments.filter((deployment) => {
      const info = deploymentStatuses[deployment.name];
      if (!info) return false;
      return getBundleDeploymentStatus(info.cachePod, info.defaultPod) === 'Deployed';
    });
    if (deployed.length === 1) {
      setSelectedDeployment(deployed[0].name);
      fetchModelsForDeployment(deployed[0].name);
    }
  }, [bundleDeployments, deploymentStatuses, selectedDeployment]);

  const fetchModelsForDeployment = async (deploymentName: string) => {
    setLoadingModels(true);
    setModelsError(null);
    setAvailableModels([]);
    setSelectedModel('');
    try {
      const response = await fetch(`/api/deployment-models?deploymentName=${deploymentName}`);
      const data = await response.json();
      if (data.success && data.models) {
        setAvailableModels(data.models);
        if (data.models.length > 0) setSelectedModel(data.models[0]);
      } else {
        setModelsError(data.error || 'Failed to fetch models');
      }
    } catch (err) {
      console.error('Error fetching models:', err);
      setModelsError('Failed to connect to the server');
    } finally {
      setLoadingModels(false);
    }
  };

  const handleDeploymentChange = (newDeployment: string | null) => {
    if (!newDeployment) return;
    setSelectedDeployment(newDeployment);
    setMessages([]);
    setAvailableModels([]);
    setSelectedModel('');
    setModelsError(null);
    if (newDeployment) {
      setTimeout(() => fetchModelsForDeployment(newDeployment), 100);
    }
  };

  const handleModelChange = (model: string | null) => {
    if (!model) return;
    setSelectedModel(model);
    setMessages([]);
  };

  const deployedBundles = bundleDeployments.filter((deployment) => {
    const info = deploymentStatuses[deployment.name];
    if (!info) return false;
    return getBundleDeploymentStatus(info.cachePod, info.defaultPod) === 'Deployed';
  });

  const isEmbeddingModel = selectedModel
    ? checkpointMapping[selectedModel]?.model_type === 'embedding'
    : false;

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || !selectedDeployment || !selectedModel) return;

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
        const response = await fetch('/api/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: inputMessage, model: selectedModel }),
        });
        const data = await response.json();
        setMessages((prev) => [
          ...prev,
          data.success
            ? {
                id: (Date.now() + 1).toString(),
                role: 'assistant' as const,
                content: `${data.embedding.length}-dimensional embedding`,
                timestamp: new Date(),
                embeddingData: data.embedding,
              }
            : {
                id: (Date.now() + 1).toString(),
                role: 'assistant' as const,
                content: data.error,
                timestamp: new Date(),
                isError: true,
              },
        ]);
      } else {
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
        setMessages((prev) => [
          ...prev,
          data.success
            ? {
                id: (Date.now() + 1).toString(),
                role: 'assistant' as const,
                content: data.content,
                timestamp: new Date(),
                metrics: data.metrics || undefined,
              }
            : {
                id: (Date.now() + 1).toString(),
                role: 'assistant' as const,
                content: data.error,
                timestamp: new Date(),
                isError: true,
              },
        ]);
      }
    } catch (err) {
      console.error('Error sending message:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant' as const,
          content: `Failed to send message - ${err instanceof Error ? err.message : 'Unknown error'}`,
          timestamp: new Date(),
          isError: true,
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const handleCopyError = (messageId: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedErrorId(messageId);
    setTimeout(() => setCopiedErrorId(null), 2000);
  };

  const handleCopyEmbedding = (messageId: string, embedding: number[]) => {
    navigator.clipboard.writeText(JSON.stringify(embedding));
    setCopiedEmbeddingId(messageId);
    setTimeout(() => setCopiedEmbeddingId(null), 2000);
  };

  const handleGetApiKey = async () => {
    setShowApiKeyInstructionsDialog(true);
    setLoadingCredentials(true);
    setCredentialsError(null);
    setKeycloakUsername('');
    setKeycloakPassword('');
    setShowPassword(false);
    try {
      const response = await fetch('/api/environments');
      const data = await response.json();
      if (!data.success || !data.defaultEnvironment) {
        setCredentialsError('Please select an environment first');
        setLoadingCredentials(false);
        return;
      }
      const credResponse = await fetch('/api/get-keycloak-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: data.defaultEnvironment }),
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

  const handleCopyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const isApiKeyError = (errorContent: string): boolean => {
    const lowerContent = errorContent.toLowerCase();
    return (
      lowerContent.includes('unauthorized') ||
      lowerContent.includes('invalid api key') ||
      lowerContent.includes('401') ||
      lowerContent.includes('api key not found in app-config.json')
    );
  };

  const parseErrorMessage = (errorContent: string): { header: string; body: string } => {
    const dashIndex = errorContent.indexOf(' - ');
    if (dashIndex !== -1) {
      const potentialHeader = errorContent.substring(0, dashIndex).trim();
      const potentialBody = errorContent.substring(dashIndex + 3).trim();
      if (
        potentialHeader &&
        potentialBody &&
        (potentialHeader.startsWith('API request failed:') ||
          potentialHeader.startsWith('Failed to') ||
          potentialHeader.includes('Error'))
      ) {
        return { header: potentialHeader, body: potentialBody };
      }
    }
    if (errorContent.startsWith('API request failed:')) {
      const statusMatch = errorContent.match(/^(API request failed: \d+ [A-Z\s]+)/);
      if (statusMatch) {
        const header = statusMatch[1];
        const remainingText = errorContent.substring(header.length).trim();
        return { header, body: remainingText || 'No additional details provided' };
      }
    }
    return { header: 'Error', body: errorContent };
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <DocumentationPanel docFile="playground.md" />

      <div>
        <h1 className="text-2xl font-semibold">Playground</h1>
        <p className="text-sm text-muted-foreground">Chat with your deployed models</p>
      </div>

      {/* Main Chat Container */}
      <div
        className="flex flex-col overflow-hidden rounded-xl border"
        style={{ height: 'calc(100vh - 260px)' }}
      >
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2">
          <Select
            value={selectedDeployment}
            onValueChange={handleDeploymentChange}
          >
            <SelectTrigger className="w-72 bg-background">
              <SelectValue placeholder="Select deployed bundle..." />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {deployedBundles.length === 0 ? (
                  <div className="px-2 py-3 text-center text-sm text-muted-foreground">
                    No deployed bundles
                  </div>
                ) : (
                  deployedBundles.map((d) => (
                    <SelectItem key={d.name} value={d.name}>
                      {d.name}
                    </SelectItem>
                  ))
                )}
              </SelectGroup>
            </SelectContent>
          </Select>

          {selectedDeployment && (
            <Select
              value={selectedModel}
              onValueChange={handleModelChange}
            >
              <SelectTrigger className="w-56 bg-background" disabled={loadingModels}>
                <SelectValue placeholder="Select model..." />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {availableModels.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}

          {selectedModel && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="bg-background"
                onClick={() => setViewCodeDialogOpen(true)}
              >
                <Code2 data-icon="inline-start" />
                View Code
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="bg-background"
                onClick={() => setMessages([])}
                disabled={messages.length === 0}
              >
                <Eraser data-icon="inline-start" />
                Clear Chat
              </Button>
            </>
          )}

          {(loading || loadingModels) && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {loading ? 'Loading deployments...' : 'Loading models...'}
            </div>
          )}
        </div>

        {/* Alerts */}
        {error && (
          <div className="px-3 pt-2">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}
        {modelsError && selectedDeployment && (
          <div className="px-3 pt-2">
            <Alert>
              <AlertDescription>Failed to load models: {modelsError}</AlertDescription>
            </Alert>
          </div>
        )}
        {!loading && deployedBundles.length === 0 && !error && (
          <div className="px-3 pt-2">
            <Alert>
              <AlertDescription>
                No deployed bundles found. Please deploy a bundle first to use the playground.
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Messages */}
        {selectedDeployment && selectedModel ? (
          <>
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto bg-muted/10 px-4 py-4">
              {messages.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <Bot className="size-14 opacity-20" />
                  <p className="text-base font-medium">
                    {isEmbeddingModel ? 'Generate embeddings' : 'Start a conversation'}
                  </p>
                  <p className="text-sm">
                    {isEmbeddingModel ? (
                      <>Enter text to embed with <strong>{selectedModel}</strong></>
                    ) : (
                      <>Chatting with <strong>{selectedModel}</strong> in {selectedDeployment}</>
                    )}
                  </p>
                </div>
              ) : (
                <>
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={cn(
                        'flex items-start gap-3',
                        message.role === 'user' && 'flex-row-reverse'
                      )}
                    >
                      {/* Avatar */}
                      <div
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-full',
                          message.role === 'user'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted'
                        )}
                      >
                        {message.role === 'user' ? (
                          <User className="size-5" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src="/icon.svg" alt="AI" className="size-6" />
                        )}
                      </div>

                      {/* Bubble */}
                      <div className="flex max-w-[70%] flex-col gap-1">
                        {message.isError ? (
                          <div className="overflow-hidden rounded-lg border border-destructive/50">
                            <div className="flex items-center justify-between border-b border-destructive/30 bg-destructive/10 px-3 py-1.5">
                              <div className="flex items-center gap-1.5">
                                <AlertCircle className="size-4 text-destructive" />
                                <span className="text-sm font-semibold text-destructive">
                                  {parseErrorMessage(message.content).header}
                                </span>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleCopyError(message.id, message.content)}
                                className={cn(
                                  copiedErrorId === message.id && 'text-green-600'
                                )}
                              >
                                <Copy />
                              </Button>
                            </div>
                            <div className="p-3">
                              <pre className="whitespace-pre-wrap break-words font-mono text-sm">
                                {parseErrorMessage(message.content).body}
                              </pre>
                              {isApiKeyError(message.content) && (
                                <div className="mt-3 border-t border-destructive/30 pt-3">
                                  <p className="text-sm">
                                    This error may be caused by an invalid or missing API key.
                                    Please{' '}
                                    <button
                                      type="button"
                                      onClick={handleGetApiKey}
                                      className="text-primary underline underline-offset-4 hover:text-primary/80"
                                    >
                                      get your API key
                                    </button>{' '}
                                    and update it on the Home page.
                                  </p>
                                </div>
                              )}
                              <span className="mt-2 block text-xs text-muted-foreground">
                                {message.timestamp.toLocaleTimeString()}
                              </span>
                            </div>
                          </div>
                        ) : message.embeddingData ? (
                          <div className="rounded-lg border bg-card p-3 shadow-sm">
                            <div className="mb-2 flex items-center justify-between">
                              <span className="text-sm font-semibold text-muted-foreground">
                                {message.embeddingData.length}-dimensional embedding
                              </span>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() =>
                                  handleCopyEmbedding(message.id, message.embeddingData!)
                                }
                                className={cn(
                                  copiedEmbeddingId === message.id && 'text-green-600'
                                )}
                              >
                                <Copy />
                              </Button>
                            </div>
                            <p className="break-all rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                              [{message.embeddingData.slice(0, 8).map((v) => v.toFixed(8)).join(', ')}, ...]
                            </p>
                            <span className="mt-1.5 block text-xs opacity-70">
                              {message.timestamp.toLocaleTimeString()}
                            </span>
                          </div>
                        ) : (
                          <div
                            className={cn(
                              'rounded-2xl px-3 py-2 shadow-sm',
                              message.role === 'user'
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-card text-card-foreground'
                            )}
                          >
                            <p className="whitespace-pre-wrap break-words text-sm">
                              {message.content}
                            </p>
                            <span
                              className={cn(
                                'mt-1 block text-xs',
                                message.role === 'user'
                                  ? 'text-primary-foreground/70'
                                  : 'text-muted-foreground'
                              )}
                            >
                              {message.timestamp.toLocaleTimeString()}
                            </span>
                          </div>
                        )}

                        {/* Metrics */}
                        {message.role === 'assistant' && message.metrics && (
                          <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                            <Rocket className="size-3 text-primary" />
                            {message.metrics.tokensPerSecond !== null && (
                              <>
                                <span>{message.metrics.tokensPerSecond.toFixed(1)} t/s</span>
                                <span className="text-muted-foreground/50">|</span>
                              </>
                            )}
                            {message.metrics.totalLatency !== null && (
                              <>
                                <span>{message.metrics.totalLatency.toFixed(2)}s</span>
                                <span className="text-muted-foreground/50">|</span>
                              </>
                            )}
                            {message.metrics.timeToFirstToken !== null && (
                              <span>
                                {message.metrics.timeToFirstToken.toFixed(2)}s to first token
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  {isSending && (
                    <div className="flex items-start gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                        <img src="/icon.svg" alt="AI" className="size-6" />
                      </div>
                      <div className="rounded-2xl bg-card px-3 py-2.5 shadow-sm">
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

            {/* Input Area */}
            <div className="border-t bg-background px-3 py-2">
              <div className="flex items-end gap-2">
                <Textarea
                  ref={inputRef}
                  placeholder={
                    isEmbeddingModel ? 'Enter text to embed...' : 'Type your message...'
                  }
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isSending}
                  rows={1}
                  className="min-h-[40px] resize-none"
                />
                <Button
                  onClick={handleSendMessage}
                  disabled={!inputMessage.trim() || isSending}
                  size="icon-sm"
                  className="size-10 shrink-0"
                >
                  <Send />
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Press Enter to send, Shift+Enter for new line
              </p>
            </div>
          </>
        ) : (
          /* Placeholder states */
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Bot className="size-20 opacity-10" />
            {!selectedDeployment && !loading && deployedBundles.length > 0 ? (
              <>
                <p className="text-base font-medium">Select a deployment to get started</p>
                <p className="text-sm">Choose a deployed bundle from the dropdown above</p>
              </>
            ) : selectedDeployment && !selectedModel && !loadingModels && availableModels.length > 0 ? (
              <>
                <p className="text-base font-medium">Select a model to continue</p>
                <p className="text-sm">Choose a model from the dropdown above</p>
              </>
            ) : null}
          </div>
        )}
      </div>

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
        onOpenChange={setShowApiKeyInstructionsDialog}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>API Key Instructions</DialogTitle>
            <DialogDescription>
              Login to the following UI domain using the credentials below to create your API key.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {loadingCredentials && (
              <div className="flex justify-center py-4">
                <Loader2 className="size-8 animate-spin text-primary" />
              </div>
            )}
            {credentialsError && (
              <Alert variant="destructive">
                <AlertDescription>{credentialsError}</AlertDescription>
              </Alert>
            )}
            {!loadingCredentials && uiDomain && (
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold">UI Domain:</p>
                <a
                  href={uiDomain}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-sm text-primary underline underline-offset-4 hover:text-primary/80"
                >
                  {uiDomain}
                </a>
              </div>
            )}
            {!loadingCredentials && keycloakUsername && keycloakPassword && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold">Username:</p>
                  <div className="flex items-center gap-2">
                    <Input
                      id={keycloakUsernameId}
                      value={keycloakUsername}
                      readOnly
                      className="font-mono"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleCopyToClipboard(keycloakUsername)}
                    >
                      <Copy />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold">Password:</p>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Input
                        id={keycloakPasswordId}
                        type={showPassword ? 'text' : 'password'}
                        value={keycloakPassword}
                        readOnly
                        className="font-mono pr-10"
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? <EyeOff /> : <Eye />}
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleCopyToClipboard(keycloakPassword)}
                    >
                      <Copy />
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {!loadingCredentials && !uiDomain && (
              <Alert>
                <AlertDescription>
                  Please select an environment with a UI domain configured.
                </AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowApiKeyInstructionsDialog(false);
                router.push('/');
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
