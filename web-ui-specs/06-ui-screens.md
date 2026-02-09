# Phase 6: UI Screens Specification
# OpenFederation Web Management Interface

## Project Information
- **Project ID**: PROJ_OPENFEDERATION_WEB_001
- **Phase**: 06_ui_screens
- **Generated**: 2025-02-06T00:00:00Z

---

## Technology Stack

- **Framework**: Next.js 14+ (App Router)
- **UI Library**: React 18
- **Styling**: Tailwind CSS + shadcn/ui
- **State Management**: Zustand
- **AT Protocol Client**: @atproto/api

---

## Screen Inventory (Phase 1)

### 1. Authentication Screens

#### 1.1 Login Screen (`/login`)
**Route**: `/login`
**Access**: Public (unauthenticated only)
**Purpose**: User authentication

**Components**:
- Email/Handle input field
- Password input field
- Login button
- Link to registration

**Data Requirements**:
- Form: `identifier` (string), `password` (string)
- API: `POST /xrpc/com.atproto.server.createSession`

**State Management**:
- Loading state during login
- Error display for invalid credentials
- Redirect to /communities on success

**User Actions**:
- Submit credentials
- Navigate to registration
- Show/hide password

---

#### 1.2 Registration Screen (`/register`)
**Route**: `/register`
**Access**: Public (unauthenticated only)
**Purpose**: New user account creation

**Components**:
- Handle input (lowercase, alphanumeric, hyphens)
- Email input
- Password input
- Invite code input (if required)
- Register button
- Link to login

**Data Requirements**:
- Form: `handle`, `email`, `password`, `inviteCode`
- API: `POST /xrpc/net.openfederation.account.register`

**State Management**:
- Form validation errors
- Registration success message
- Pending approval notice

**User Actions**:
- Submit registration
- Navigate to login
- Show/hide password

---

### 2. Dashboard Screens

#### 2.1 Communities List (`/communities`)
**Route**: `/communities`
**Access**: Authenticated users only
**Purpose**: View and manage user's communities

**Components**:
- Page header with "Create Community" button
- Communities grid/list
- Each community card shows:
  - Community handle
  - Display name
  - DID method badge (plc/web)
  - Created date
  - Actions menu (view, edit, export)

**Data Requirements**:
- API: `GET /xrpc/net.openfederation.community.list` (Phase 2)
- Phase 1: Query communities where created_by = current_user

**State Management**:
- Communities list
- Loading state
- Empty state ("No communities yet")

**User Actions**:
- Create new community
- View community details
- Edit community profile (Phase 2)
- Export community (Phase 2)

---

#### 2.2 Create Community Screen (`/communities/new`)
**Route**: `/communities/new`
**Access**: Approved users only
**Purpose**: Create new community

**Components**:
- Community handle input
- DID method selector (radio: plc/web)
- Domain input (conditional, if did:web selected)
- Display name input (optional)
- Description textarea (optional)
- Create button
- Cancel button

**Data Requirements**:
- Form: `handle`, `didMethod`, `domain?`, `displayName?`, `description?`
- API: `POST /xrpc/net.openfederation.community.create`

**State Management**:
- Form state
- DID method selection
- Success modal with rotation key (plc) or DID document (web)

**User Actions**:
- Toggle DID method
- Submit form
- Copy rotation key/document
- Navigate to communities list

**Critical UX**:
- For did:plc: Show modal with rotation key + warning to save it
- For did:web: Show instructions to host DID document

---

### 3. Admin Screens

#### 3.1 Admin Dashboard (`/admin`)
**Route**: `/admin`
**Access**: Admin role only
**Purpose**: Manage pending users and create invites

**Components**:
- Page title: "Admin Dashboard"
- Tab navigation: [Pending Users, Invite Codes]

**Tab 1: Pending Users**
- Pending accounts count badge
- Table with columns:
  - Handle
  - Email
  - Registered date
  - Actions (Approve, Reject buttons)
- Empty state: "No pending accounts"

**Tab 2: Invite Codes**
- "Create Invite" button
- Invite creation form:
  - Max uses (number input, default 1)
  - Expires in (select: 1 day, 7 days, 30 days, never)
  - Generate button
- Generated invite display with copy button

**Data Requirements**:
- API: `GET /xrpc/net.openfederation.account.listPending`
- API: `POST /xrpc/net.openfederation.account.approve`
- API: `POST /xrpc/net.openfederation.account.reject`
- API: `POST /xrpc/net.openfederation.invite.create`

**State Management**:
- Pending users list
- Generated invite code
- Active tab

**User Actions**:
- Approve user account
- Reject user account
- Create invite code
- Copy invite code

---

### 4. Shared Components

#### 4.1 Navigation Bar
**Location**: All authenticated pages
**Components**:
- App logo/name
- Navigation links: [Communities, Admin (if admin)]
- User menu dropdown:
  - User handle
  - Settings (Phase 2)
  - Logout

#### 4.2 Auth Guard
**Purpose**: Redirect unauthenticated users to /login
**Implementation**: HOC or middleware

#### 4.3 Admin Guard
**Purpose**: Redirect non-admin users from /admin
**Implementation**: Check user role

---

## User Flows

### Flow 1: New User Registration
1. Visit `/register`
2. Fill form (handle, email, password, invite code)
3. Submit → Show "Account pending approval" message
4. Admin reviews in `/admin`
5. Admin approves → User receives email
6. User logs in at `/login`
7. Redirect to `/communities`

### Flow 2: Create did:plc Community
1. User at `/communities`
2. Click "Create Community"
3. Navigate to `/communities/new`
4. Fill form:
   - Handle: "my-community"
   - DID Method: plc (selected)
   - Display Name: "My Cool Community"
   - Description: "A community for..."
5. Submit
6. Modal appears with rotation key
7. **User must copy/save rotation key**
8. Click "Done" → Navigate to `/communities`

### Flow 3: Create did:web Community
1. User at `/communities`
2. Click "Create Community"
3. Navigate to `/communities/new`
4. Fill form:
   - Handle: "my-community"
   - DID Method: web (selected)
   - Domain: "example.com"
   - Display Name: "My Cool Community"
5. Submit
6. Modal appears with DID document JSON and instructions
7. **User must host JSON at https://example.com/.well-known/did.json**
8. Click "Done" → Navigate to `/communities`

---

## Responsive Design

- **Desktop**: Full layout with sidebar navigation
- **Tablet**: Collapsible navigation
- **Mobile**: Bottom navigation bar + hamburger menu

---

## Accessibility

- Semantic HTML (proper heading hierarchy)
- ARIA labels for interactive elements
- Keyboard navigation support
- Focus indicators
- Form validation messages
- Loading indicators

---

## Error Handling

### Authentication Errors
- Invalid credentials → "Invalid email/handle or password"
- Account pending → "Your account is pending admin approval"
- Account rejected → "Your account was rejected"

### Validation Errors
- Empty required field → "This field is required"
- Invalid email → "Please enter a valid email"
- Handle taken → "This handle is already in use"
- Invalid handle format → "Handle can only contain lowercase letters, numbers, and hyphens"

### Network Errors
- Connection failed → "Network error, please try again"
- Timeout → "Request timed out, please try again"
- 500 error → "Server error, please contact support"

---

## Phase 1 Screens Summary

| Screen | Route | Auth Required | Admin Only | Status |
|--------|-------|--------------|-----------|---------|
| Login | /login | No | No | Phase 1 |
| Register | /register | No | No | Phase 1 |
| Communities List | /communities | Yes | No | Phase 1 |
| Create Community | /communities/new | Yes | No | Phase 1 |
| Admin Dashboard | /admin | Yes | Yes | Phase 1 |

Total: **5 screens**

---

## Phase 2 Screens (Future)

- Community Detail View (`/communities/[did]`)
- Edit Community Profile (`/communities/[did]/edit`)
- Community Settings (`/communities/[did]/settings`)
- User Profile (`/profile`)
- User Settings (`/settings`)

---

## Implementation Checklist

### Next.js Setup
- [x] Create Next.js app with TypeScript
- [x] Configure Tailwind CSS
- [x] Install shadcn/ui components
- [x] Set up folder structure

### Authentication
- [ ] Create login page
- [ ] Create registration page
- [ ] Implement auth state management (Zustand)
- [ ] Add auth guard middleware
- [ ] Handle token refresh

### Communities
- [ ] Create communities list page
- [ ] Create community creation form
- [ ] Implement DID method selection
- [ ] Add rotation key/document modals
- [ ] Add community cards

### Admin
- [ ] Create admin dashboard
- [ ] Add pending users table
- [ ] Implement approve/reject actions
- [ ] Add invite code generation
- [ ] Add admin guard

### Shared Components
- [ ] Navigation bar
- [ ] User menu dropdown
- [ ] Loading spinners
- [ ] Error alerts
- [ ] Toast notifications

