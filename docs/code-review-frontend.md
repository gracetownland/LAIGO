# Code Review: Frontend (React)

**Reviewer:** Kiro  
**Date:** 2026-05-15  
**Scope:** `frontend/src/` — React 19, TypeScript, Vite 7, MUI 7, Tailwind CSS  
**Status:** Complete

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 0     | 0     |
| High     | 2     | 0     |
| Medium   | 5     | 0     |
| Low      | 5     | 0     |
| **Total**| **12**| **0** |

---

## What's Well-Designed

**XSS protection is properly implemented.** AI responses use `react-markdown` with `rehype-sanitize` — the correct approach for rendering LLM-generated markdown safely. User messages render as plain text via MUI `Typography` (no `dangerouslySetInnerHTML`). This is a strong security posture for a legal AI tool.

**WebSocket hook is production-quality.** `useWebSocket.ts` implements:
- Exponential backoff reconnection (max 10 attempts)
- 30-second heartbeat ping/pong
- Client-side rate limiting (10 messages/second default)
- JWT token rotation before expiry (reconnects 30s before token expires)
- Request/response correlation via `requestId`
- Proper cleanup on disconnect/unmount

**WebSocket message validation is thorough.** The 4-step validation pipeline (`useWebSocket.validation.ts`) validates structure, message type, type-specific fields, and action-specific data before processing. This prevents malformed server messages from crashing the UI.

**Optimistic updates with rollback.** NotificationContext implements optimistic UI updates (mark as read, delete) with automatic rollback on API failure. Good UX pattern.

**Auth token management is correct.** Uses Amplify `sessionStorage` (not localStorage) for tokens, fetches fresh tokens via `fetchAuthSession()` before API calls, and handles 403 responses by signing out.

---

## High Issues

### H1. Duplicate WebSocket connections for every authenticated user
- **Status:** ⬜ Open
- **Files:** `contexts/NotificationContext.tsx`, `hooks/useWebSocket.ts`
- **Description:** The `NotificationContext` creates its own independent WebSocket connection for real-time notification delivery. Meanwhile, the `useWebSocket` hook creates a separate WebSocket connection for chat streaming. Both connect to the same WebSocket API endpoint.
- **Impact:** 
  - Double the WebSocket connections per user (2x connection table entries, 2x Lambda authorizer invocations)
  - Double the DynamoDB connection tracking writes
  - Potential race conditions if both connections receive the same message
  - Increased cost and complexity
- **Fix:** Unify into a single WebSocket connection. Either:
  1. Have `NotificationContext` use the `useWebSocket` hook's connection and register a listener for `notification_delivery` actions, OR
  2. Create a shared WebSocket provider at the app level that both notification and chat features consume.

---

### H2. Empty catch blocks suppress errors silently
- **Status:** ⬜ Open
- **Files:** `App.tsx`, `contexts/NotificationContext.tsx`, `hooks/useWebSocket.ts`
- **Description:** Multiple empty `catch` blocks throughout the codebase:
```typescript
// App.tsx
} catch (error) {
}

// NotificationContext.tsx - handleWebSocketMessage
} catch (err) {
}

// useWebSocket.ts - onmessage
} catch {
}
```
- **Impact:** Errors are silently swallowed. If the WebSocket receives malformed JSON, or if auth token refresh fails, or if the disclaimer API errors — the user sees nothing and debugging is impossible.
- **Fix:** At minimum, log errors to console in development:
```typescript
} catch (error) {
  if (import.meta.env.DEV) {
    console.error("WebSocket message parse error:", error);
  }
}
```
For production, consider a lightweight error reporting service.

---

## Medium Issues

### M1. No route-level authorization guards
- **Status:** ⬜ Open
- **File:** `App.tsx`
- **Description:** Route access is controlled by `activePerspective` state which determines which `<Routes>` block renders. However, the shared case routes (`/case/:caseId/*`) are accessible to ALL authenticated users regardless of role. There's no route guard preventing a student from manually navigating to an admin URL if they somehow know it.
- **Impact:** Low practical risk because the backend enforces authorization. But a student navigating to `/ai-configuration` would see a blank page or error rather than a clean redirect.
- **Fix:** Add a `<ProtectedRoute>` wrapper component that checks user roles and redirects unauthorized users:
```tsx
const ProtectedRoute = ({ allowedRoles, children }) => {
  const { userInfo } = useUser();
  if (!userInfo?.groups.some(r => allowedRoles.includes(r))) {
    return <Navigate to="/" replace />;
  }
  return children;
};
```

---

### M2. `StrictMode` is commented out
- **Status:** ⬜ Open
- **File:** `main.tsx`
- **Description:**
```typescript
// <StrictMode>
<BrowserRouter>
  <App />
</BrowserRouter>,
// </StrictMode>
```
React StrictMode helps detect unsafe lifecycle methods, legacy API usage, and unexpected side effects during development. It's disabled here, likely because it causes double-renders that interfere with WebSocket connections.
- **Impact:** Missing development-time warnings for potential issues. The WebSocket double-render issue should be fixed properly (using refs and cleanup functions) rather than disabling StrictMode.
- **Fix:** Re-enable StrictMode and ensure all effects properly handle cleanup (which the WebSocket hook already does correctly).

---

### M3. `WebSocketMessage` interface has all fields optional — weak type safety
- **Status:** ⬜ Open
- **File:** `types/websocket.ts`
- **Description:**
```typescript
export interface WebSocketMessage {
  type?: "start" | "chunk" | "complete" | "error" | "pong" | ...;
  requestId?: string;
  action?: string;
  content?: string;
  data?: Record<string, unknown>;
  ...
}
```
Every field is optional, which means TypeScript won't catch missing field access at compile time. The runtime validation in `useWebSocket.validation.ts` compensates, but the type system isn't helping developers.
- **Fix:** Use discriminated unions:
```typescript
type WebSocketMessage = 
  | { type: "chunk"; requestId: string; action: string; content: string }
  | { type: "complete"; requestId: string; action: string; data: Record<string, unknown> }
  | { type: "error"; requestId: string; action: string; content: string }
  | { type: "start"; requestId: string; action: string }
  | { type: "pong" };
```

---

### M4. Notification metadata uses `[key: string]: any` — type hole
- **Status:** ⬜ Open
- **File:** `types/notification.ts`
- **Description:**
```typescript
metadata: {
  caseId?: string;
  caseName?: string;
  ...
  [key: string]: any;  // Allows anything
};
```
The index signature `[key: string]: any` defeats TypeScript's type checking for the entire metadata object. Any typo in known field names won't be caught.
- **Fix:** Remove the index signature or use `Record<string, unknown>` for the catch-all:
```typescript
metadata: {
  caseId?: string;
  caseName?: string;
  feedbackId?: string;
  summaryId?: string;
  transcriptionId?: string;
} & Record<string, unknown>;
```

---

### M5. No request timeout or retry logic in API service layer
- **Status:** ⬜ Open
- **File:** `services/notificationService.ts`
- **Description:** All API calls use bare `fetch()` with no timeout configuration. If the backend is slow or unresponsive, the UI will hang indefinitely waiting for a response.
- **Impact:** Poor UX during backend issues. Users see infinite loading spinners.
- **Fix:** Add `AbortController` with timeout:
```typescript
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
```

---

## Low Issues

### L1. `connectionState` in `sendMessage` dependency array causes unnecessary re-creation
- **Status:** ⬜ Open
- **File:** `hooks/useWebSocket.ts`
- **Description:**
```typescript
const sendMessage = useCallback(
  (message: unknown) => { ... },
  [connectionState, maxMessages, windowMs],  // connectionState changes on every connect/disconnect
);
```
Every time `connectionState` changes, `sendMessage` is recreated, which could trigger re-renders in consuming components that depend on it.
- **Fix:** Remove `connectionState` from deps — the function already checks `wsRef.current?.readyState` internally:
```typescript
const sendMessage = useCallback(
  (message: unknown) => { ... },
  [maxMessages, windowMs],
);
```

---

### L2. Password stored in component state after sign-up for auto-login
- **Status:** ⬜ Open
- **File:** `pages/Login.tsx`
- **Description:** After `confirmSignUp`, the code auto-signs in using the password still in state:
```typescript
const user = await signIn({ username: email, password });
```
The password remains in React state until the component unmounts (which happens on successful login via `window.location.reload()`).
- **Impact:** Minimal — the password is in memory briefly and the page reloads immediately. React DevTools could expose it during the brief window.
- **Mitigation:** This is an accepted pattern for auto-login after confirmation. The `window.location.reload()` clears all state.

---

### L3. `window.location.reload()` used for post-login navigation
- **Status:** ⬜ Open
- **File:** `pages/Login.tsx`
- **Description:** After successful sign-in, the app does a full page reload instead of using React Router navigation. This loses any in-memory state and forces a complete re-initialization.
- **Impact:** Slightly slower login experience (full page load vs SPA navigation). Not a bug, but not idiomatic React.
- **Mitigation:** This is likely intentional to ensure Amplify auth state is fully initialized. The alternative (lifting auth state to a parent and re-rendering) is more complex.

---

### L4. No loading/error states for RoleLabelsContext
- **Status:** ⬜ Open
- **File:** `contexts/RoleLabelsContext.tsx`
- **Description:** The context fetches role labels on mount but provides no loading or error state to consumers. If the fetch fails, consumers silently get default labels without knowing the fetch failed.
- **Impact:** Minimal — defaults are reasonable. But if labels are customized and the fetch fails, users see wrong labels without any indication.

---

### L5. `@types/` packages in `dependencies` instead of `devDependencies`
- **Status:** ⬜ Open
- **File:** `frontend/package.json`
- **Description:** Several `@types/` packages are in `dependencies`:
```json
"dependencies": {
  "@types/dompurify": "^3.0.5",
  "@types/jspdf": "^1.3.3",
  "@types/marked": "^5.0.2",
  "@types/uuid": "^10.0.0",
  ...
}
```
Type definition packages are only needed at build time, not runtime.
- **Fix:** Move all `@types/*` packages to `devDependencies`.

---

## Architectural Recommendations

### R1. Unify WebSocket connections
- **Priority:** High
- **Description:** Create a single `WebSocketProvider` at the app level that manages one connection. Both the notification system and chat streaming should consume this shared connection, routing messages by `action` field.
- **Benefit:** Halves WebSocket connections, simplifies connection management, reduces DynamoDB writes.

---

### R2. Add error boundary and error reporting
- **Priority:** Medium
- **Description:** Add React Error Boundaries around major sections (chat, case view, admin). Replace empty catch blocks with structured error logging. Consider a lightweight error reporting integration for production.
- **Benefit:** Better debugging, user-visible error states instead of blank screens.

---

### R3. Implement request timeout and retry
- **Priority:** Medium
- **Description:** Create a shared `apiClient` utility that wraps `fetch` with:
- Automatic auth token injection
- Request timeout (10s default)
- Retry with backoff for 5xx errors
- Consistent error response parsing
- **Benefit:** Resilient API communication, consistent error handling, DRY code.

---

## Review Progress

- [x] Architecture & folder structure
- [x] Lambda functions (Python)
- [x] Lambda functions (Node.js handlers)
- [x] CDK infrastructure (all 7 stacks)
- [x] Frontend (React app, auth flow, API service layer)
- [ ] Database (migrations, schema)
- [ ] Security (holistic view)
