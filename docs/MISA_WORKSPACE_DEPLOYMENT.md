# MISA company workspace deployment

The Node backend owns company workspaces, active MISA catalogs, aliases, and mapping profiles in MongoDB. The FastAPI converter reads them through authenticated internal HTTP calls.

## Local development

Run from the repository root:

```powershell
npm run dev
npm --prefix frontend run dev
```

`scripts/dev.ps1` creates stable local-only secrets under `.artifacts/local-ai/` and passes the same values to Node and FastAPI. These files are ignored by Git.

## Render Node backend

Configure:

```env
MASTER_DATA_WORKSPACES_ENABLED=true
CONVERSION_CONTEXT_SECRET=<long-random-secret>
CONVERTER_SERVICE_TOKEN=<different-long-random-secret>
CONVERTER_INTERNAL_URL=https://<converter-service>.onrender.com
CONVERTER_TIMEOUT_MS=60000
```

Keep the existing `MONGO_URI`, `JWT_SECRET`, frontend URL, payment, and authentication variables.

## Render FastAPI converter

Use exactly the same two shared secrets as the Node backend:

```env
CONVERSION_CONTEXT_SECRET=<same-as-node>
CONVERTER_SERVICE_TOKEN=<same-as-node>
NODE_INTERNAL_API_URL=https://<node-backend>.onrender.com/api/internal
MASTER_DATA_CONTEXT_TIMEOUT_SECONDS=15
MASTER_DATA_CONTEXT_CACHE_SECONDS=300
MAPPING_PROFILE_TIMEOUT_SECONDS=15
```

Keep `MISA_TEMPLATE_DIR`, AI variables, and CORS settings unchanged.

## Vercel frontend

Configure:

```env
VITE_MASTER_DATA_WORKSPACES_ENABLED=true
```

The existing `VITE_NODE_API_URL` and `VITE_PYTHON_API_URL` must still point to the Node backend and converter.

## Rollback

Set both values to `false` and redeploy the affected service:

```env
MASTER_DATA_WORKSPACES_ENABLED=false
VITE_MASTER_DATA_WORKSPACES_ENABLED=false
```

This hides the workspace UI and stops mounting workspace/internal routes without deleting MongoDB data.
