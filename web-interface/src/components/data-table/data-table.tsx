'use client';

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { QueryFeedback } from '@/components/query-feedback';
import { EmptyState } from '@/components/empty-state';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  total?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: Error | null;
  hasData?: boolean;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  total = 0,
  page = 0,
  pageSize = 50,
  onPageChange,
  isLoading,
  isFetching,
  error = null,
  hasData = true,
  onRetry,
  emptyTitle = 'No entries to show',
  emptyDescription = 'Entries will appear here as people use your server.',
}: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: Math.ceil(total / pageSize),
  });

  const totalPages = Math.ceil(total / pageSize);
  const canPrev = page > 0;
  const canNext = page < totalPages - 1;

  return (
    <div className="space-y-4" aria-busy={isLoading || isFetching}>
      <QueryFeedback error={error} hasData={hasData} onRetry={onRetry} isFetching={isFetching} />
      {isFetching && !isLoading && <p role="status" className="text-xs text-muted-foreground">Updating results…</p>}
      {(!error || hasData) && <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  <div role="status" className="flex items-center justify-center text-muted-foreground">
                    Loading...
                  </div>
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : null}
          </TableBody>
        </Table>
        {!isLoading && table.getRowModel().rows.length === 0 && (
          <EmptyState title={emptyTitle} description={emptyDescription} className="rounded-none border-0 border-t border-solid" />
        )}
      </div>
      {total > 0 && onPageChange && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-2">
          <p className="text-sm text-muted-foreground">
            {Math.min(page * pageSize + 1, total)}–{Math.min((page + 1) * pageSize, total)} of {total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page - 1)}
              aria-label="Previous page"
              disabled={!canPrev || isLoading}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page + 1)}
              aria-label="Next page"
              disabled={!canNext || isLoading}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
      </>}
    </div>
  );
}
