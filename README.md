# Nails by Divya — Platform Backend & Knowledge System

Modular Express backend providing grounded AI customer support (Divv AI), resilient PostgreSQL database integration with connection pooling, transactional migration tracking, and administrative capabilities for Nails by Divya.

---

## 1. Quick Start

### Prerequisites
- **Node.js**: v18.0.0 or later (v20+ recommended)
- **PostgreSQL**: v15.0 or later (v18.6 locally verified)
- **npm**: v9.0.0 or later

### Installation
```bash
# Clone or navigate to the backend repository
cd nails-ai-backend/nails-ai-backend-main

# Install dependencies
npm install
```

---

## 2. Environment Configuration

Copy the example environment configuration to `.env`:
```bash
cp .env.example .env
```

Edit `.env` to configure your local credentials:
```env
PORT=3000
NODE_ENV=development

# PostgreSQL Connection
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/nailsbydivya_staging
PGHOST=localhost
PGPORT=5432
PGDATABASE=nailsbydivya_staging
PGUSER=postgres
PGPASSWORD=your_password
PGSSLMODE=disable

# AI & Admin
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.1-flash-lite-preview
ADMIN_API_KEY=your_admin_secret_key
```

> [!IMPORTANT]
> Never commit `.env` to version control. The repository `.gitignore` ensures credentials remain local.

---

## 3. Database & Migrations

The platform uses a transactional, fail-fast migration system driven by `database/manifest.json`.

### Check Migration Status
```bash
npm run migrate:status
```

### Apply Pending Migrations
```bash
npm run migrate
```
The migrator:
1. Verifies checksum integrity against `database/manifest.json`.
2. Automatically detects pre-existing foundation tables (e.g. `users`, `products`, `orders`) and bootstrap-records `001_initial_schema` without re-running DDL.
3. Applies pending migrations in atomic transactions (`BEGIN ... COMMIT`).
4. Tracks applied migrations in `schema_migrations`.

---

## 4. Running the Server

### Development Mode (with hot-reload)
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

---

## 5. API Endpoints

| Method | Path | Description | Access |
|---|---|---|---|
| `GET` | `/` | Root Health Check | Public |
| `GET` | `/health` | Subsystem Health (DB, AI, Knowledge) | Public |
| `POST` | `/chat` | Grounded Customer Support Chat (Divv AI) | Public |
| `POST` | `/rebuild-knowledge` | Website Re-Scan & In-Memory Re-Index | Admin (`x-admin-key`) |

---

## 6. Testing & Quality Assurance

Run the automated backend test suite:
```bash
npm test
```
The test suite validates:
- Configuration parsing and sanitization.
- Error redacting (passwords and connection URIs masked).
- Health check endpoints (`GET /` and `GET /health`).
- Divv AI grounded response contract and knowledge fallback.
- Migration runner logic, foundation detection, and SHA-256 checksums.
