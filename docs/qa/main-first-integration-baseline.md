# Main-First Integration Baseline

Baseline commit: `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`

Captured before feature integration on 2026-07-30 from the unchanged main baseline.

## Gate

Command:

```powershell
npm run qa:main-integration
```

The gate runs, in order, backend `node --test`, converter `python -m pytest -q --tb=short`, frontend `npm test`, `npm run lint`, and `npm run build`. It stops at the first failure.

## Results

Results from the unchanged main baseline:

| Step | Result |
|---|---|
| Backend `node --test` | 134 tests, 134 passed, 0 failed, 0 skipped |
| Converter `python -m pytest -q --tb=short` | 329 passed in 146.92s, 0 failed, 0 skipped |
| Frontend `npm test` | 48 tests, 48 passed, 0 failed, 0 skipped |
| Frontend `npm run lint` | Passed, exit code 0 |
| Frontend `npm run build` | Passed, exit code 0; 2,463 modules transformed; built in 8.05s |

Pre-existing skips: none.

Pre-existing failures: none.
