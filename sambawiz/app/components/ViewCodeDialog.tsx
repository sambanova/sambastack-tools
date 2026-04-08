'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface ViewCodeDialogProps {
  open: boolean;
  onClose: () => void;
  apiKey: string;
  apiDomain: string;
  modelName: string;
  isEmbedding?: boolean;
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
      {value === index && <div className="pt-2">{children}</div>}
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
}: ViewCodeDialogProps) {
  const [selectedTab, setSelectedTab] = useState<string>('curl');
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [copiedPython, setCopiedPython] = useState(false);

  // Normalize API domain to remove trailing slash for display
  const normalizedApiDomain = apiDomain.endsWith('/') ? apiDomain.slice(0, -1) : apiDomain;

  // Hide API key in display
  const displayApiKey = '•'.repeat(Math.min(apiKey.length, 32));

  const curlCodeDisplay = isEmbedding
    ? `curl ${normalizedApiDomain}/v1/embeddings \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${displayApiKey}" \\
  -d '{
    "input": "The quick brown fox jumps over the lazy dog",
    "model": "${modelName}"
  }'`
    : `curl -H "Authorization: Bearer ${displayApiKey}" \\
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

  const curlCodeActual = isEmbedding
    ? `curl ${normalizedApiDomain}/v1/embeddings \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "input": "The quick brown fox jumps over the lazy dog",
    "model": "${modelName}"
  }'`
    : `curl -H "Authorization: Bearer ${apiKey}" \\
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

  const pythonCodeDisplay = isEmbedding
    ? `from sambanova import SambaNova

client = SambaNova(
    base_url="${normalizedApiDomain}/v1",
    api_key="${displayApiKey}",
)

response = client.embeddings.create(
    model="${modelName}",
    input="The quick brown fox jumps over the lazy dog"
)

print(response)`
    : `from sambanova import SambaNova

client = SambaNova(
    api_key="${displayApiKey}",
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

  const pythonCodeActual = isEmbedding
    ? `from sambanova import SambaNova

client = SambaNova(
    base_url="${normalizedApiDomain}/v1",
    api_key="${apiKey}",
)

response = client.embeddings.create(
    model="${modelName}",
    input="The quick brown fox jumps over the lazy dog"
)

print(response)`
    : `from sambanova import SambaNova

client = SambaNova(
    api_key="${apiKey}",
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

  const isCopied = selectedTab === 'curl' ? copiedCurl : copiedPython;
  const handleCopy = selectedTab === 'curl' ? handleCopyCurl : handleCopyPython;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-2xl min-h-[500px]" showCloseButton={true}>
        <DialogHeader>
          <DialogTitle>View Code</DialogTitle>
        </DialogHeader>

        <Tabs value={selectedTab} onValueChange={setSelectedTab}>
          <div className="flex items-center justify-between mb-2">
            <TabsList>
              <TabsTrigger value="curl">cURL</TabsTrigger>
              <TabsTrigger value="python">Python</TabsTrigger>
            </TabsList>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopy}
                    className={cn(
                      isCopied
                        ? 'text-green-600 border-green-600 hover:text-green-600'
                        : 'text-primary border-primary hover:text-primary'
                    )}
                  >
                    <Copy className="mr-1.5 size-3.5" />
                    {isCopied ? 'Copied!' : 'Copy Code'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isCopied ? 'Copied!' : 'Copy to clipboard'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          <TabsContent value="curl">
            <div className="rounded overflow-hidden">
              <SyntaxHighlighter
                language="bash"
                style={vscDarkPlus}
                customStyle={{
                  fontSize: '0.875rem',
                  padding: '16px',
                  margin: 0,
                  borderRadius: '0.25rem',
                }}
              >
                {curlCodeDisplay}
              </SyntaxHighlighter>
            </div>
          </TabsContent>

          <TabsContent value="python">
            <div className="rounded overflow-hidden">
              <SyntaxHighlighter
                language="python"
                style={vscDarkPlus}
                customStyle={{
                  fontSize: '0.875rem',
                  padding: '16px',
                  margin: 0,
                  borderRadius: '0.25rem',
                }}
              >
                {pythonCodeDisplay}
              </SyntaxHighlighter>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
