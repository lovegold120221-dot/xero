# Project Overview: Voxx-Zero (Beatrice)

Voxx-Zero, also known as **Beatrice**, is a real-time voice AI agent specialized for the Belgian market. It leverages the **Eburon Live API** for low-latency PCM16 bidirectional audio, featuring voice activity detection (VAD), interruption handling, and multi-language support (147 languages, primary nl-BE).

The project integrates:
- **WhatsApp**: Baileys-based integration for messaging, contact management, and history sync.
- **Belgian Admin Tools**: 10 specialized tools for KBO/CBE lookup, VAT validation, Peppol e-invoicing, etc.
- **Memory System**: Persistent user memory stored in Supabase with full-text search.
- **Automation**: Cerebras-powered browser automation and sandbox sub-agent for complex tasks.
- **Architecture**: React 19 frontend (Vite) + Express/Node.js backend.

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19, Vite 6, Tailwind CSS v4, Framer Motion |
| **Backend** | Express 4, tsx runtime, Node 22+ |
| **AI/Voice** | Eburon Live API, Cerebras (Browser), Ollama (LLM Proxy) |
| **Auth** | Firebase Auth (Google OAuth) |
| **Database** | Supabase (PostgreSQL), IndexedDB (local) |
| **WhatsApp** | Baileys (`@whiskeysockets/baileys`) |
| **Deployment**| Ubuntu VPS, Docker Compose, Traefik/NGINX, PM2 |

## Building and Running

### Prerequisites
- Node.js 22+
- Eburon Core API Key
- Supabase Project
- Firebase Project

### Local Development
1.  **Install dependencies**:
    ```bash
    npm install
    ```
2.  **Environment Setup**:
    ```bash
    cp .env.example .env
    # Fill in EBURON_CORE_KEY, SUPABASE_*, FIREBASE_*
    ```
3.  **Run Development Servers**:
    ```bash
    npm run dev:full     # Frontend (:3000) + Backend (:4200)
    # Or separately:
    npm run dev          # Frontend only
    npm run dev:api      # Backend only
    ```

### Database Migrations
Run the following SQL scripts in the Supabase SQL Editor:
- `supabase-migration-settings.sql`: Fixes `user_settings` schema.
- `supabase-migration-memories.sql`: Creates `memories` table.

### Production (VPS)
Managed via PM2 and Docker:
- **Backend**: `pm2 start voxx-backend`
- **Docker**: `docker compose -f docker-compose.whatsapp.yml up -d`

## Development Conventions

- **Branding**: Rigorously adhere to "Eburon" branding. Use `npm run check:eburon-branding` to validate.
- **Architecture**:
    - All AI calls must route through `server/eburon-provider.ts`.
    - Use the repository pattern in `server/db/` for database access.
    - Frontend components live in `src/components/`.
- **Tooling**:
    - WhatsApp integration uses 10 individual skill functions (e.g., `send_whatsapp_message`) instead of a single god function.
    - AI agent context is initialized with user memories and knowledge domains at session start.
- **Theme**: Supports Dark and Light modes using CSS custom properties. Ensure all new components use variables from `src/index.css`.
- **Validation**: Always run `npm run lint` before committing (it performs a `tsc --noEmit` check).

## Key File Map

- `src/components/BeatriceAgent.tsx`: Main voice/session orchestration logic.
- `server/index.ts`: Primary Express API entry point and static file serving.
- `server/whatsapp.ts`: Core WhatsApp management logic (Baileys).
- `server/eburon-provider.ts`: Central hub for AI/LLM provider interactions.
- `server/belgian-tools.ts`: Implementation of the 10 Belgian admin skills.
- `src/lib/audio.ts`: PCM16 streaming and recording handlers.
- `scripts/cerebras_browser.py`: Python wrapper for browser automation.
