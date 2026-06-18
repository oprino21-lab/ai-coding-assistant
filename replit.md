# CodeLite — AI Coding Assistant Backend

An AI-powered coding assistant backend that connects to GitHub repositories, analyzes codebases, generates code changes using OpenRouter AI, and applies them after user approval.

## Architecture

**Stack:** Node.js + Express, deployed on Render  
**AI Provider:** OpenRouter API (Claude 3.5 Sonnet by default)  
**GitHub Integration:** OAuth2 (passport-github2)  
**Port:** 5000

### Module Structure

```
src/
├── index.js                  # Express app entry point
├── middleware/
│   └── auth.js               # requireAuth middleware
├── routes/
│   ├── auth.js               # GitHub OAuth routes
│   ├── repo.js               # Repo connect/analyze routes
│   ├── ai.js                 # AI instruction + task routes
│   └── changes.js            # Change approval/rejection routes
├── services/
│   ├── githubAuth.js         # Passport GitHub strategy
│   ├── githubService.js      # Clone, read, write, commit, push
│   ├── repoAnalyzer.js       # File tree + tech stack analysis
│   ├── aiService.js          # OpenRouter API calls (plan + generate)
│   └── taskEngine.js         # In-memory task state management
└── utils/
    └── logger.js             # Winston logger
```

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/github` | Start GitHub OAuth flow |
| GET | `/auth/github/callback` | OAuth callback (set on Render) |
| GET | `/auth/me` | Get current user info |
| POST | `/auth/logout` | Log out |

### Repositories
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/repo/list` | List user's GitHub repos |
| POST | `/api/repo/connect` | Clone/connect a repo `{ repoFullName }` |
| POST | `/api/repo/analyze` | Analyze repo structure `{ repoFullName }` |
| GET | `/api/repo/connected` | List connected repos |

### AI Engine
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ai/instruct` | Submit instruction `{ repoFullName, instruction }` |
| GET | `/api/ai/task/:taskId` | Poll task status |
| POST | `/api/ai/explain` | Explain a file `{ repoFullName, filePath }` |

### Changes
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/changes` | List all user tasks |
| GET | `/api/changes/:taskId` | Get task + diff preview |
| POST | `/api/changes/:taskId/approve` | Apply changes + push to GitHub |
| POST | `/api/changes/:taskId/reject` | Reject changes |

## Workflow

1. `GET /auth/github` → user logs in
2. `POST /api/repo/connect` with `{ repoFullName: "user/repo" }` → repo cloned
3. `POST /api/ai/instruct` with `{ repoFullName, instruction }` → returns `taskId`
4. Poll `GET /api/ai/task/:taskId` until `status === "awaiting_approval"`
5. `GET /api/changes/:taskId` → view proposed diff
6. `POST /api/changes/:taskId/approve` → changes committed & pushed to GitHub
7. OR `POST /api/changes/:taskId/reject` → no changes made

## Task Statuses
- `pending` → created
- `thinking` → AI analyzing codebase
- `planning` → AI generating plan
- `generating` → AI writing code
- `awaiting_approval` → ready for user review
- `applying` → writing files + pushing
- `completed` → done ✅
- `failed` → error occurred
- `rejected` → user rejected

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `GITHUB_CLIENT_ID` | GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App Client Secret |
| `GITHUB_CALLBACK_URL` | OAuth callback URL |
| `SESSION_SECRET` | Express session secret |
| `PORT` | Server port (default 5000) |

## User Preferences

- Keep code modular — one concern per file
- No frontend in this phase
- Prioritize working end-to-end flow over advanced features
