import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  className?: string;
  title: string;
  description?: string;
  children?: React.ReactNode;
}

export function EmptyState({ icon: Icon, title, description, children, className }: EmptyStateProps) {
  return (
    <div role="status" className={cn("flex min-h-52 flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center", className)}>
      {Icon && <div className="flex size-12 items-center justify-center rounded-full bg-muted mb-4">
        <Icon className="size-6 text-muted-foreground" aria-hidden />
      </div>}
      <h3 className="max-w-md text-base font-semibold leading-snug">{title}</h3>
      {description && (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
