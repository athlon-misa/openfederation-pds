import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function QueryFeedback({ error, hasData, onRetry, isFetching, subject = 'data' }: {
  error: Error | null; hasData: boolean; onRetry?: () => void; isFetching?: boolean; subject?: string;
}) {
  if (!error) return null;
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <AlertCircle className="size-5 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{hasData ? `Could not refresh ${subject}` : `Could not load ${subject}`}</p>
        <p className="mt-1 text-muted-foreground">{hasData ? 'Showing the last available data. ' : ''}{error.message}</p>
      </div>
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry} disabled={isFetching}>
        <RefreshCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} aria-hidden />{isFetching ? 'Retrying…' : 'Try again'}
      </Button>}
    </div>
  );
}
