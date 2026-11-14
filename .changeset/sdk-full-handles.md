---
"@open-federation/sdk": patch
---

`user.handle` is the full AT Protocol handle (#411): the server now returns the name plus its handle domain, and against an older server that returns the name only, the SDK completes it with the domain from `describeServer` (on login, registration, the ATProto callback and refresh). `displayHandle()` on the client uses that domain once known. New standalone `fullHandle(handle, domain?)`.
