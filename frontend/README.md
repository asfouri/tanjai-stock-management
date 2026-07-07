# Tanjai Stock Management Frontend

Next.js dashboard for stock management, Excel import review, Supabase login, and reporting views.

## Setup

```bash
npm install
cp .env.example .env.local
```

Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and optionally `NEXT_PUBLIC_API_URL`.

## Development

```bash
npm run dev
```

By default, the app runs on `http://localhost:3000` and calls the backend at `http://localhost:3005`.

## Checks

```bash
npm run lint
npm run build
```
