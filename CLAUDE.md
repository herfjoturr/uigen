# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run setup        # First-time setup: install deps, generate Prisma client, run migrations
npm run dev          # Start dev server with Turbopack
npm run build        # Production build
npm run test         # Run all tests (Vitest)
npm run db:reset     # Reset and re-migrate SQLite database
```

To run a single test file:
```bash
npx vitest run src/lib/__tests__/file-system.test.ts
```

Environment variable `ANTHROPIC_API_KEY` in `.env` is optional — the app falls back to a mock provider that generates static demo components when absent.

## Architecture

UIGen is an AI-powered React component generator with live preview. Users describe components in chat; Claude generates them into a virtual file system; the result is rendered in a sandboxed iframe.

### Three-panel UI (`src/app/main-content.tsx`)
- **Left:** Chat interface (`src/components/chat/`)
- **Right top/bottom (tabs):** Live preview iframe / Monaco code editor with file tree

### Request flow
1. User sends prompt → `ChatInterface` POSTs to `/api/chat`
2. API route (`src/app/api/chat/route.ts`) calls Claude with two tools:
   - `str_replace_editor` (`src/lib/tools/str-replace.ts`) — targeted file edits
   - `file_manager` (`src/lib/tools/file-manager.ts`) — create/rename/delete files
3. Claude streams tool calls back; the API route applies them to a `VirtualFileSystem` instance and returns the updated state
4. Client contexts update: `FileSystemContext` and `ChatContext` re-render the preview and editor

### Virtual file system (`src/lib/file-system.ts`)
In-memory, serializable file tree. All component files live here — nothing is written to disk. Serialized as JSON and stored in the `Project.data` DB column between sessions.

### LLM provider (`src/lib/provider.ts`)
Wraps `@ai-sdk/anthropic`. In mock mode (no API key), returns hardcoded component demos. Both real and mock implement `LanguageModelV1` so the API route is unaware of the difference.

### System prompt (`src/lib/prompts/generation.tsx`)
Instructs Claude to:
- Always create `/App.jsx` as the entry point
- Use Tailwind CSS for styling
- Use `@/` import aliases for project files (no HTML files)
- Keep responses concise

### Authentication (`src/lib/auth.ts`)
JWT stored in an `httpOnly` cookie (via `jose`). Middleware at `src/middleware.ts` verifies the session for protected routes. Anonymous users can use the app without signing in; their work is ephemeral unless they create an account.

### Data persistence (`prisma/schema.prisma`)
SQLite via Prisma. Two models:
- `User` — email + bcrypt-hashed password
- `Project` — stores serialized chat messages (`messages: String JSON`) and virtual FS state (`data: String JSON`), optionally linked to a user

### State management
Two React contexts:
- `FileSystemContext` (`src/lib/contexts/file-system-context.tsx`) — owns the `VirtualFileSystem` instance; drives the editor and preview
- `ChatContext` (`src/lib/contexts/chat-context.tsx`) — owns message history and streaming state

### Testing
Vitest + React Testing Library + jsdom. Tests live alongside source in `__tests__/` subdirectories. No special setup beyond `npm run test`.
