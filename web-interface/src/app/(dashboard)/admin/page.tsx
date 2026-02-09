'use client';

import { AdminGuard } from '@/components/admin-guard';
import { PendingUsersTable } from '@/components/pending-users-table';
import { InviteCodeForm } from '@/components/invite-code-form';
import { AdminCommunitiesTable } from '@/components/admin-communities-table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function AdminPage() {
  return (
    <AdminGuard>
      <div>
        <h1 className="text-2xl font-bold mb-6">Admin</h1>
        <Tabs defaultValue="pending">
          <TabsList>
            <TabsTrigger value="pending">Pending Users</TabsTrigger>
            <TabsTrigger value="invites">Invite Codes</TabsTrigger>
            <TabsTrigger value="communities">Communities</TabsTrigger>
          </TabsList>
          <TabsContent value="pending" className="mt-4">
            <PendingUsersTable />
          </TabsContent>
          <TabsContent value="invites" className="mt-4">
            <InviteCodeForm />
          </TabsContent>
          <TabsContent value="communities" className="mt-4">
            <AdminCommunitiesTable />
          </TabsContent>
        </Tabs>
      </div>
    </AdminGuard>
  );
}
