# MISA company workspace Phase 1 QA

Date: 2026-07-14

## Automated checks

- Backend Node tests: 64 passed.
- Converter Python tests: 162 passed.
- Frontend master-data utility tests: 4 passed.
- Frontend ESLint: passed.
- Frontend Prettier check: passed.
- Frontend production build: passed.
- Backend dependency audit at high severity: 0 vulnerabilities.
- Workspace `npm run qa:fast`: 5/5 checks passed.

## API integration flow

Executed against an isolated MongoDB QA database and removed the database afterward:

1. Register QA user.
2. Create company workspace.
3. Upload and activate item/account catalogs.
4. Create signed conversion context.
5. Analyze and preview a raw Excel file.
6. Search an active MISA catalog and save a source-specific alias.
7. Reject the stale pre-alias context.
8. Refresh context and verify the alias is applied.
9. Save mapping profile in MongoDB.
10. Export a real `.xls` MISA template.
11. Upload the same schema again and reuse the MongoDB profile.
12. Verify a second user cannot read the first user's workspace.
13. Verify conversion without a workspace still works with `not_configured` status.

Result: passed. Export retained 59 headers, 2 merged ranges, and all 59 template column widths.

## Browser QA

Desktop and mobile Chrome checks passed for:

- Login.
- Workspace selection and dedicated workspace page.
- Active catalog display.
- Saved mapping profile display.
- Preview/readiness flow.
- MISA download.
- Catalog search, alias confirmation, and immediate resolution refresh.
- Mobile layout without horizontal overflow.
- No page exceptions or HTTP 5xx responses.

Local Google Identity Services logged an origin authorization warning because the temporary localhost origin is not configured in the Google client. This does not affect workspace/converter behavior and must be handled in Google Cloud OAuth origin configuration, not in this feature's code.
