import { Badge } from '@/components/ui/badge';

const roleVariants: Record<string, 'default' | 'secondary' | 'outline'> = {
  admin: 'default',
  moderator: 'secondary',
  user: 'outline',
  owner: 'default',
  member: 'outline',
};

export function RoleBadge({ role }: { role: string }) {
  return (
    <Badge variant={roleVariants[role] || 'outline'}>
      {role}
    </Badge>
  );
}
