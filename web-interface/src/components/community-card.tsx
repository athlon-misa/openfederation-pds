import Link from 'next/link';
import type { CommunityListItem } from '@/lib/api/types';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export function CommunityCard({ community }: { community: CommunityListItem }) {
  return (
    <Link href={`/communities/${encodeURIComponent(community.did)}`}>
      <Card className="hover:bg-muted/50 transition-colors">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{community.displayName}</CardTitle>
            <div className="flex gap-1">
              {community.role && (
                <Badge variant={community.role === 'owner' ? 'default' : 'secondary'}>
                  {community.role}
                </Badge>
              )}
              <Badge variant="secondary">{community.didMethod}</Badge>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">@{community.handle}</p>
        </CardHeader>
        <CardContent>
          {community.description && (
            <p className="text-sm text-muted-foreground mb-2">{community.description}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Created {new Date(community.createdAt).toLocaleDateString()}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
