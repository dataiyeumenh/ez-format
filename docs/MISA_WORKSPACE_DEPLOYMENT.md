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
CONVERTER_PUBLIC_PROXY_ENABLED=true
CONVERTER_GATEWAY_USAGE_READY=true
CONVERTER_ARTIFACT_STORAGE_DRIVER=mongodb
CONVERTER_MONGODB_GRIDFS_BUCKET=ezformatArtifacts
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
MISA_TEMPLATE_DIR=fixtures/templates
MISA_TEMPLATE_MANIFEST_PATH=config/misa-template-manifest.json
```

Package both configured paths in the converter deployment image. Relative paths
resolve from the converter directory. Startup verifies canonical filenames,
SHA-256 values, sheet names, header rows, column counts, and ordered headers for
every export target; a missing or mismatched template/manifest prevents startup.
Do not point production at an unreviewed local template folder.

Before deployment, run `python -m app.misa_templates verify` from `converter/`.
For an intentional rotation, use the documented `regenerate-manifest` and
`review-manifest` commands in `converter/README.md`, review the candidate diff,
then commit the reviewed template and versioned manifest together. The service
never updates trust data automatically.

Keep AI variables and CORS settings unchanged.

## Vercel frontend

Configure:

```env
VITE_MASTER_DATA_WORKSPACES_ENABLED=true
```

Set `VITE_API_URL` (preferred) or `VITE_NODE_API_URL` to the Node backend. Browser requests reach the converter only through `/api/converter`; do not expose the FastAPI URL to Vite.

## Rollback

Set both values to `false` and redeploy the affected service:

```env
MASTER_DATA_WORKSPACES_ENABLED=false
VITE_MASTER_DATA_WORKSPACES_ENABLED=false
```

This hides the workspace UI and stops mounting workspace/internal routes without deleting MongoDB data.
