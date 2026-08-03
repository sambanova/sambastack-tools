'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  IconButton,
  Box,
  Tabs,
  Tab,
  Button,
  Tooltip,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface ViewCodeDialogProps {
  open: boolean;
  onClose: () => void;
  apiKey: string;
  apiDomain: string;
  modelName: string;
  isEmbedding?: boolean;
  // Audio model modes — mutually exclusive with isEmbedding and each other.
  isAsr?: boolean;
  isTts?: boolean;
  // Selected qwen3-tts voice/language, echoed into the TTS snippets.
  ttsVoice?: string;
  ttsLanguage?: string;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`code-tabpanel-${index}`}
      aria-labelledby={`code-tab-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ pt: 2 }}>{children}</Box>}
    </div>
  );
}

export default function ViewCodeDialog({
  open,
  onClose,
  apiKey,
  apiDomain,
  modelName,
  isEmbedding = false,
  isAsr = false,
  isTts = false,
  ttsVoice = 'vivian',
  ttsLanguage = 'english',
}: ViewCodeDialogProps) {
  const [selectedTab, setSelectedTab] = useState(0);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [copiedPython, setCopiedPython] = useState(false);

  const handleTabChange = (event: React.SyntheticEvent, newValue: number) => {
    setSelectedTab(newValue);
  };

  // Normalize API domain to remove trailing slash for display
  const normalizedApiDomain = apiDomain.endsWith('/') ? apiDomain.slice(0, -1) : apiDomain;

  // Hide API key in display
  const displayApiKey = '•'.repeat(Math.min(apiKey.length, 32));

  // Build the cURL snippet for the active model mode, parameterized by the key
  // value so we can render a masked version and copy the real one.
  const buildCurl = (key: string): string => {
    if (isEmbedding) {
      return `curl ${normalizedApiDomain}/v1/embeddings \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${key}" \\
  -d '{
    "input": "The quick brown fox jumps over the lazy dog",
    "model": "${modelName}"
  }'`;
    }
    if (isAsr) {
      return `curl ${normalizedApiDomain}/v1/audio/transcriptions \\
  -H "Authorization: Bearer ${key}" \\
  -F "model=${modelName}" \\
  -F "file=@audio.mp3" \\
  -F "language=en"`;
    }
    if (isTts) {
      return `curl ${normalizedApiDomain}/v1/audio/speech \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelName}",
    "input": "Today is a wonderful day to build something people love!",
    "voice": "${ttsVoice}",
    "language": "${ttsLanguage}"
  }'`;
    }
    return `curl -H "Authorization: Bearer ${key}" \\
     -H "Content-Type: application/json" \\
     -d '{
	"stream": false,
	"model": "${modelName}",
	"messages": [
		{
			"role": "system",
			"content": "You are a helpful assistant"
		},
		{
			"role": "user",
			"content": "What is 3+3?"
		}
	]
	}' \\
     -X POST ${normalizedApiDomain}/v1/chat/completions`;
  };

  const buildPython = (key: string): string => {
    if (isEmbedding) {
      return `from sambanova import SambaNova

client = SambaNova(
    base_url="${normalizedApiDomain}/v1",
    api_key="${key}",
)

response = client.embeddings.create(
    model="${modelName}",
    input="The quick brown fox jumps over the lazy dog"
)

print(response)`;
    }
    if (isAsr) {
      return `from sambanova import SambaNova

client = SambaNova(
    api_key="${key}",
    base_url="${normalizedApiDomain}/v1",
)

with open("audio.mp3", "rb") as audio_file:
    response = client.audio.transcriptions.create(
        model="${modelName}",
        file=audio_file,
        language="en"
    )

print(response.text)`;
    }
    if (isTts) {
      // TTS streams Server-Sent Events of base64 float32 PCM chunks, so use a
      // raw streaming request rather than the SDK helper.
      return `import base64
import json
import requests

resp = requests.post(
    "${normalizedApiDomain}/v1/audio/speech",
    headers={"Authorization": "Bearer ${key}", "Content-Type": "application/json"},
    json={
        "model": "${modelName}",
        "input": "Today is a wonderful day to build something people love!",
        "voice": "${ttsVoice}",
        "language": "${ttsLanguage}",
    },
    stream=True,
)

pcm = bytearray()
for line in resp.iter_lines():
    if not line or not line.startswith(b"data:"):
        continue
    payload = line[len(b"data:"):].strip()
    if payload == b"[DONE]":
        break
    event = json.loads(payload)
    if event.get("audio_b64"):
        pcm += base64.b64decode(event["audio_b64"])

# pcm is float32 little-endian PCM @ 24 kHz mono
print(f"received {len(pcm) // 4} samples")`;
    }
    return `from sambanova import SambaNova

client = SambaNova(
    api_key="${key}",
    base_url="${normalizedApiDomain}/v1",
)

response = client.chat.completions.create(
    model="${modelName}",
    messages=[
        {"role": "system", "content": "You are a helpful assistant"},
        {"role": "user", "content": "What is 3+3?"}
    ],
    temperature=0.1,
    top_p=0.1
)

print(response.choices[0].message.content)`;
  };

  const curlCodeDisplay = buildCurl(displayApiKey);
  const curlCodeActual = buildCurl(apiKey);
  const pythonCodeDisplay = buildPython(displayApiKey);
  const pythonCodeActual = buildPython(apiKey);

  const handleCopyCurl = async () => {
    try {
      await navigator.clipboard.writeText(curlCodeActual);
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  const handleCopyPython = async () => {
    try {
      await navigator.clipboard.writeText(pythonCodeActual);
      setCopiedPython(true);
      setTimeout(() => setCopiedPython(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          minHeight: '500px',
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pb: 1,
        }}
      >
        View Code
        <IconButton
          aria-label="close"
          onClick={onClose}
          size="small"
          sx={{
            color: 'grey.500',
          }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
          <Tabs value={selectedTab} onChange={handleTabChange} aria-label="code tabs">
            <Tab label="cURL" id="code-tab-0" aria-controls="code-tabpanel-0" />
            <Tab label="Python" id="code-tab-1" aria-controls="code-tabpanel-1" />
          </Tabs>
        </Box>

        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            mb: 2,
          }}
        >
          <Tooltip title={selectedTab === 0 ? (copiedCurl ? 'Copied!' : 'Copy to clipboard') : (copiedPython ? 'Copied!' : 'Copy to clipboard')}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<ContentCopyIcon />}
              onClick={selectedTab === 0 ? handleCopyCurl : handleCopyPython}
              sx={{
                color: (selectedTab === 0 ? copiedCurl : copiedPython) ? 'success.main' : 'primary.main',
                borderColor: (selectedTab === 0 ? copiedCurl : copiedPython) ? 'success.main' : 'primary.main',
              }}
            >
              {(selectedTab === 0 ? copiedCurl : copiedPython) ? 'Copied!' : 'Copy Code'}
            </Button>
          </Tooltip>
        </Box>

        <TabPanel value={selectedTab} index={0}>
          <Box
            sx={{
              borderRadius: 1,
              overflow: 'hidden',
              '& pre': {
                margin: 0,
                borderRadius: 1,
              },
            }}
          >
            <SyntaxHighlighter
              language="bash"
              style={vscDarkPlus}
              customStyle={{
                fontSize: '0.875rem',
                padding: '16px',
                margin: 0,
              }}
            >
              {curlCodeDisplay}
            </SyntaxHighlighter>
          </Box>
        </TabPanel>

        <TabPanel value={selectedTab} index={1}>
          <Box
            sx={{
              borderRadius: 1,
              overflow: 'hidden',
              '& pre': {
                margin: 0,
                borderRadius: 1,
              },
            }}
          >
            <SyntaxHighlighter
              language="python"
              style={vscDarkPlus}
              customStyle={{
                fontSize: '0.875rem',
                padding: '16px',
                margin: 0,
              }}
            >
              {pythonCodeDisplay}
            </SyntaxHighlighter>
          </Box>
        </TabPanel>
      </DialogContent>
    </Dialog>
  );
}
