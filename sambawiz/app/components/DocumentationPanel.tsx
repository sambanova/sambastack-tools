'use client';

import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { BookOpen, Loader2 } from 'lucide-react';

interface DocumentationPanelProps {
  docFile: string;
}

export default function DocumentationPanel({ docFile }: DocumentationPanelProps) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !content) {
      setLoading(true);
      setError(null);
      fetch(`/docs/${docFile}`)
        .then(res => {
          if (!res.ok) throw new Error('Failed to load documentation');
          return res.text();
        })
        .then(text => setContent(text))
        .catch(() => setError('Failed to load documentation'))
        .finally(() => setLoading(false));
    }
  }, [open, content, docFile]);

  return (
    <>
      <Button
        size="icon"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 size-14 rounded-full shadow-lg"
        aria-label="Open documentation"
      >
        <BookOpen />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="mt-16 h-[calc(100vh-64px)] w-full overflow-y-auto sm:max-w-[500px]">
          <SheetHeader>
            <SheetTitle>Documentation</SheetTitle>
          </SheetHeader>

          {loading && (
            <div className="flex justify-center py-8">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {error && (
            <p className="py-4 text-sm text-destructive">{error}</p>
          )}

          {content && !loading && !error && (
            <div className="prose prose-sm max-w-none dark:prose-invert mt-4 overflow-y-auto [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-zinc-900 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:text-zinc-100">
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
