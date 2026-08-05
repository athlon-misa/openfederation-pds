# Reverse Pagination for `com.atproto.repo.listRecords`

## Purpose

Make cursor pagination return a stable global record order for both forward and
reverse requests. The current handler reverses an already ascending page, which
makes consecutive reverse pages appear in the wrong order.

## Scope

- Add an explicit `reverse` query option to the repository read module.
- Query records in the requested direction:
  - forward: `rkey > cursor`, ascending;
  - reverse: `rkey < cursor`, descending.
- Keep cursors exclusive and derive the next cursor from the final item in the
  returned order.
- Pass `reverse` through from the XRPC handler without locally reversing the
  response.
- Add integration coverage for two forward pages and two reverse pages.

## Out of Scope

- Database schema changes.
- Changes to the public XRPC request or response shape.
- SDK and lexicon changes.

## Error Handling

Existing validation, authorization, collection filtering, and limit handling
remain unchanged. An empty page continues to omit the cursor.

## Verification

The new test creates records with ordered rkeys, retrieves them across two
pages in each direction, and asserts that every record appears exactly once in
the requested global order. The affected API test suite will run alongside the
targeted test.
