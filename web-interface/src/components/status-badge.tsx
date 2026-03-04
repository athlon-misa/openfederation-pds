import { Badge } from '@/components/ui/badge';

const statusVariants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default',
  approved: 'default',
  pending: 'secondary',
  suspended: 'outline',
  rejected: 'destructive',
  disabled: 'destructive',
  takendown: 'destructive',
  deactivated: 'outline',
  expired: 'outline',
  exhausted: 'outline',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={statusVariants[status] || 'secondary'}>
      {status}
    </Badge>
  );
}
