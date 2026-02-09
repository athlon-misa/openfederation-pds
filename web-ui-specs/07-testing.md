# Phase 7: Testing Strategy
# OpenFederation Web Management Interface

## Project Information
- **Project ID**: PROJ_OPENFEDERATION_WEB_001
- **Phase**: 07_testing
- **Generated**: 2025-02-06T00:00:00Z

---

## Testing Stack

- **Unit Testing**: Jest + React Testing Library
- **Integration Testing**: Jest + Supertest
- **E2E Testing**: Playwright (Phase 2)
- **API Testing**: Jest + @atproto/api
- **Mocking**: MSW (Mock Service Worker)

---

## Test Coverage Goals

- **Unit Tests**: 70% coverage
- **Integration Tests**: Critical paths covered
- **E2E Tests**: Happy paths covered (Phase 2)

---

## Phase 1 Test Plan

### 1. Authentication Tests

#### Unit Tests
```javascript
describe('Authentication Service', () => {
  test('login with valid credentials', async () => {
    const result = await login('alice@example.com', 'password123');
    expect(result).toHaveProperty('accessJwt');
    expect(result).toHaveProperty('refreshJwt');
  });
  
  test('login with invalid credentials', async () => {
    await expect(login('alice@example.com', 'wrong')).rejects.toThrow('AuthenticationRequired');
  });
  
  test('login with pending account', async () => {
    await expect(login('pending@example.com', 'password')).rejects.toThrow('AccountNotApproved');
  });
  
  test('register with valid data', async () => {
    const result = await register({
      handle: 'newuser',
      email: 'new@example.com',
      password: 'password123'
    });
    expect(result.status).toBe('pending');
  });
  
  test('register with taken handle', async () => {
    await expect(register({
      handle: 'alice',
      email: 'new@example.com',
      password: 'password123'
    })).rejects.toThrow('HANDLE_EXISTS');
  });
});
```

---

### 2. Community Tests

#### Unit Tests
```javascript
describe('Community Service', () => {
  test('create community with did:plc', async () => {
    const result = await createCommunity({
      handle: 'test-community',
      didMethod: 'plc',
      displayName: 'Test Community'
    });
    expect(result.did).toMatch(/^did:plc:/);
    expect(result).toHaveProperty('primaryRotationKey');
  });
  
  test('create community with did:web', async () => {
    const result = await createCommunity({
      handle: 'test-community',
      didMethod: 'web',
      domain: 'example.com'
    });
    expect(result.did).toBe('did:web:example.com');
    expect(result).toHaveProperty('didDocument');
  });
  
  test('create community without domain for did:web', async () => {
    await expect(createCommunity({
      handle: 'test',
      didMethod: 'web'
    })).rejects.toThrow('DOMAIN_REQUIRED');
  });
  
  test('create community with unapproved user', async () => {
    await expect(createCommunity({
      handle: 'test',
      didMethod: 'plc'
    }, pendingUser)).rejects.toThrow('USER_NOT_APPROVED');
  });
});
```

---

### 3. Admin Tests

#### Unit Tests
```javascript
describe('Admin Service', () => {
  test('list pending users', async () => {
    const result = await listPendingUsers(adminUser);
    expect(result.accounts).toBeInstanceOf(Array);
  });
  
  test('list pending users as non-admin', async () => {
    await expect(listPendingUsers(regularUser)).rejects.toThrow('FORBIDDEN');
  });
  
  test('approve pending user', async () => {
    const result = await approveUser(pendingUserId, adminUser);
    expect(result.success).toBe(true);
  });
  
  test('reject pending user', async () => {
    const result = await rejectUser(pendingUserId, adminUser);
    expect(result.success).toBe(true);
  });
  
  test('create invite code', async () => {
    const result = await createInvite({ maxUses: 5 }, adminUser);
    expect(result.code).toHaveLength(9);
    expect(result.maxUses).toBe(5);
  });
});
```

---

### 4. Integration Tests

```javascript
describe('User Registration Flow', () => {
  test('complete registration flow', async () => {
    // 1. Register
    const user = await request(app)
      .post('/xrpc/net.openfederation.account.register')
      .send({
        handle: 'testuser',
        email: 'test@example.com',
        password: 'password123'
      });
    expect(user.body.status).toBe('pending');
    
    // 2. Admin approves
    const approval = await request(app)
      .post('/xrpc/net.openfederation.account.approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: user.body.id });
    expect(approval.status).toBe(200);
    
    // 3. User logs in
    const session = await request(app)
      .post('/xrpc/com.atproto.server.createSession')
      .send({
        identifier: 'testuser',
        password: 'password123'
      });
    expect(session.body).toHaveProperty('accessJwt');
  });
});

describe('Community Creation Flow', () => {
  test('create and retrieve community', async () => {
    // 1. Create community
    const community = await request(app)
      .post('/xrpc/net.openfederation.community.create')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        handle: 'test-community',
        didMethod: 'plc',
        displayName: 'Test Community'
      });
    expect(community.body.did).toMatch(/^did:plc:/);
    
    // 2. Retrieve community profile
    const profile = await request(app)
      .get('/xrpc/com.atproto.repo.getRecord')
      .query({
        repo: community.body.did,
        collection: 'net.openfederation.community.profile',
        rkey: 'self'
      });
    expect(profile.body.value.displayName).toBe('Test Community');
  });
});
```

---

## Test Data Fixtures

### User Fixtures
```javascript
const fixtures = {
  adminUser: {
    did: 'did:plc:admin123',
    handle: 'admin',
    email: 'admin@test.com',
    role: 'admin',
    status: 'approved'
  },
  approvedUser: {
    did: 'did:plc:user123',
    handle: 'alice',
    email: 'alice@test.com',
    role: 'user',
    status: 'approved'
  },
  pendingUser: {
    did: 'did:plc:pending123',
    handle: 'pending',
    email: 'pending@test.com',
    role: 'user',
    status: 'pending'
  }
};
```

---

## Mock Setup

### Mock AT Protocol API
```javascript
import { rest } from 'msw';
import { setupServer } from 'msw/node';

const server = setupServer(
  rest.post('/xrpc/com.atproto.server.createSession', (req, res, ctx) => {
    const { identifier, password } = req.body;
    if (password === 'correct') {
      return res(ctx.json({
        did: 'did:plc:test123',
        handle: identifier,
        accessJwt: 'mock-access-token',
        refreshJwt: 'mock-refresh-token'
      }));
    }
    return res(ctx.status(401), ctx.json({ error: 'AuthenticationRequired' }));
  })
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

---

## CI/CD Test Pipeline

```yaml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run unit tests
        run: npm run test:unit
      
      - name: Run integration tests
        run: npm run test:integration
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

---

## Test Checklist (Phase 1)

### Authentication
- [x] Login with valid credentials
- [x] Login with invalid credentials
- [x] Login with pending account
- [x] Login with rejected account
- [x] Register with valid data
- [x] Register with taken handle
- [x] Register with taken email
- [x] Register without invite (if required)
- [x] Token refresh

### Communities
- [x] Create did:plc community
- [x] Create did:web community
- [x] Create with invalid handle
- [x] Create with unapproved account
- [x] Retrieve community profile

### Admin
- [x] List pending users as admin
- [x] List pending as non-admin (403)
- [x] Approve pending user
- [x] Reject pending user
- [x] Create invite code
- [x] Invite code expiration
- [x] Invite code max uses

---

## Performance Testing (Phase 2)

- Load testing with k6
- Database query optimization
- API response time monitoring
- Frontend rendering performance

---

## Security Testing (Phase 2)

- SQL injection attempts
- XSS prevention
- CSRF token validation
- Rate limiting verification
- JWT token expiration

