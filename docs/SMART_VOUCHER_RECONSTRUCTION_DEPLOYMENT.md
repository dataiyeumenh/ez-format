# Smart voucher reconstruction deployment

Giai đoạn 3 chạy trên ba service hiện có và thêm một TTL store cho draft tạm:

```text
Vercel frontend
-> Render Node backend + MongoDB
-> Render FastAPI converter + Redis-compatible TTL store
-> optional AI Gateway/ngrok -> Ollama local
```

## 1. Rollout an toàn

1. Deploy code với tất cả feature flag ở `false`.
2. Chạy migration/index creation bằng cách khởi động Node backend một lần.
3. Cấu hình Redis TLS cho converter.
4. Bật shadow mode cho workspace beta.
5. So sánh số chứng từ, số dòng và tổng tiền với luồng hiện tại.
6. Tắt shadow mode rồi mới cho export.
7. Bật frontend flag cuối cùng.

Luồng mapping truyền thống không bị xóa và là rollback path.

## 2. Node backend / Render

```env
MASTER_DATA_WORKSPACES_ENABLED=true
VOUCHER_RECONSTRUCTION_ENABLED=true
RECONSTRUCTION_STORE_TTL_HOURS=24
RECONSTRUCTION_CREATE_LIMIT_PER_15_MINUTES=20
RECONSTRUCTION_SHADOW_MODE=true
RECONSTRUCTION_BETA_WORKSPACE_IDS=<comma-separated-workspace-objectids>

CONVERSION_CONTEXT_SECRET=<same-random-secret-as-converter>
CONVERTER_SERVICE_TOKEN=<same-service-token-as-converter>
CONVERTER_INTERNAL_URL=https://<converter-service>
```

MongoDB tạo thêm collections:

- `voucherreconstructionruns`
- `reconstructionprofiles`
- `reconstructiondecisions`

Không lưu raw workbook trong MongoDB.

## 3. Converter / Render

Production phải dùng TTL store chịu được restart:

```env
VOUCHER_RECONSTRUCTION_ENABLED=true
RECONSTRUCTION_SHADOW_MODE=true

RECONSTRUCTION_STORE_PROVIDER=redis
RECONSTRUCTION_REDIS_URL=rediss://<user>:<password>@<host>:<port>
RECONSTRUCTION_REDIS_PREFIX=ezformat:production:reconstruction
RECONSTRUCTION_ENVIRONMENT=production
RECONSTRUCTION_STORE_TTL_HOURS=24

RECONSTRUCTION_MAX_FILE_BYTES=31457280
RECONSTRUCTION_MAX_ROWS=50000
RECONSTRUCTION_MAX_CELLS=3000000
RECONSTRUCTION_MAX_DRAFTS=10000
RECONSTRUCTION_ANALYZE_LIMIT_PER_15_MINUTES=5
RECONSTRUCTION_EXPORT_LIMIT_PER_15_MINUTES=20

CONVERSION_CONTEXT_SECRET=<same-random-secret-as-node>
CONVERTER_SERVICE_TOKEN=<same-service-token-as-node>
NODE_INTERNAL_API_URL=https://<node-service>/api/internal
RECONSTRUCTION_NOTIFY_NODE=true
RECONSTRUCTION_NODE_REQUIRED=false
```

Install dependencies từ `converter/requirements.txt`; package `redis` chỉ được import khi provider là `redis`.

Local development có thể dùng:

```env
RECONSTRUCTION_STORE_PROVIDER=filesystem
RECONSTRUCTION_STORE_DIR=.artifacts/reconstructions
```

Không dùng filesystem tạm của Render cho phiên review cần resume sau restart.

## 4. Optional AI Gateway

Converter:

```env
AI_PROVIDER=remote_http
AI_BASE_URL=https://<gateway>/v1/misa/suggest-mapping
AI_RECONSTRUCTION_BASE_URL=https://<gateway>/v1/misa/suggest-reconstruction
AI_TOKEN=<gateway-token>
AI_RECONSTRUCTION_TIMEOUT_SECONDS=20
AI_RECONSTRUCTION_PROMPT_VERSION=phase3-v1
AI_RECONSTRUCTION_CACHE_TTL_SECONDS=3600
AI_RECONSTRUCTION_CACHE_MAX_ENTRIES=500
AI_REQUIRED=false
```

AI Gateway/Ollama:

```env
AI_GATEWAY_TOKEN=<same-gateway-token>
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b
```

AI offline không chặn reconstruction. UI hiển thị cảnh báo và user tiếp tục review thủ công.

## 5. Frontend / Vercel

```env
VITE_NODE_API_URL=https://<node-service>
VITE_PYTHON_API_URL=https://<converter-service>
VITE_MASTER_DATA_WORKSPACES_ENABLED=true
VITE_VOUCHER_RECONSTRUCTION_ENABLED=true
```

Không đặt context secret, converter service token, Redis URL hoặc AI token trên Vercel.

## 6. Shadow mode

Khi `RECONSTRUCTION_SHADOW_MODE=true`:

- Analyze, review và validation vẫn hoạt động.
- Converter từ chối export Phase 3.
- Luồng mapping truyền thống vẫn export bình thường.

Chỉ chuyển về `false` sau khi golden files và beta workspace đạt:

- Không mất/nhân đôi dòng.
- Số chứng từ đúng.
- Tổng tiền/VAT đối soát được.
- Template `.xls` giữ nguyên format.

## 7. Rollback

Rollback nhanh:

```env
VITE_VOUCHER_RECONSTRUCTION_ENABLED=false
VOUCHER_RECONSTRUCTION_ENABLED=false
```

Không xóa MongoDB collections hoặc Redis keys khi rollback. TTL sẽ tự xóa draft tạm; profile/audit được giữ để phục vụ bật lại.

## 8. Post-deploy smoke test

1. `GET <node>/api/health` trả `voucherReconstruction: true`.
2. `GET <converter>/healthz` trả capability tương ứng.
3. Login và chọn workspace.
4. Upload file mua vào có ít nhất hai dòng cùng hóa đơn.
5. Xác nhận hệ thống tạo một chứng từ nhiều dòng.
6. Sửa một field và kiểm tra revision tăng.
7. Chạy validation và acknowledge warning nếu có.
8. Approve rồi export.
9. Mở `.xls`/`.zip`, kiểm tra template MISA thật.
10. Re-upload cùng schema và xác nhận active profile được reuse.
