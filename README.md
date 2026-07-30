# EzFormat - Chuẩn Hoá Dữ Liệu Kế Toán

Dự án chuyển đổi file kế toán sử dụng **MERN Stack** (MongoDB, Express, React, Node.js).

---

## Cấu trúc dự án

```
ez-format/
├── backend/      ← Node.js + Express + MongoDB (auth, admin)
├── converter/    ← Python FastAPI (Excel → MISA convert, validate, AI)
└── frontend/     ← React + Vite + Tailwind CSS
```

---

## Yêu cầu

- Node.js >= 18
- MongoDB (local hoặc MongoDB Atlas)

---

## Cài đặt & Chạy

### Cả stack (khuyến nghị)

```bash
npm install
npm run setup:fixtures
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
cd converter && python -m pip install -r requirements.txt && cd ..

# Terminal 1 — hoặc một lệnh:
npm run desktop
```

| Service   | URL                      |
| --------- | ------------------------ |
| Frontend  | http://localhost:5173    |
| Node API  | http://localhost:5000    |
| Converter | http://localhost:8000    |

Frontend proxy: `/api` → Node, `/python-api` → Converter.

### QA/QC tự động

```powershell
npm run qa              # kiểm tra đầy đủ (build + 43 test)
npm run qa:fast         # nhanh (~15s)
npm run qa:autopilot    # chạy QA, retry 3 lần, wake agent nếu fail
npm run qa:watch        # lặp QA mỗi 60 phút (terminal nền)
```

Chi tiết: [docs/QA_AUTOMATION.md](docs/QA_AUTOMATION.md)

### Cải tiến UI (sau QA)

```powershell
npm run ui:improve     # lint + prettier + build
npm run pipeline       # qa:fast rồi ui:improve
npm run ui:watch       # lặp cải tiến UI (3h)
```

Extensions: Tailwind IntelliSense, Prettier, ESLint, Color Highlight, Live Server — xem [docs/UI_AUTOMATION.md](docs/UI_AUTOMATION.md).

### Cải tiến UX liên tục

```powershell
npm run improve:loop    # lặp mỗi 2h (terminal Cursor + monitored output)
```

Chi tiết: [docs/IMPROVEMENT_LOOP.md](docs/IMPROVEMENT_LOOP.md)

### 1. Node backend (auth / admin)

```bash
cd backend
npm install
cp .env.example .env   # nếu có
npm run dev
```

### PayOS settlement deployment

PayOS settlement writes the payment and user entitlement in one MongoDB transaction.

- Set all three `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, and `PAYOS_CHECKSUM_KEY` values only with a MongoDB Atlas, replica-set, or sharded deployment.
- The backend runs `hello` against the connected MongoDB instance during startup. A standalone deployment fails startup when PayOS is configured.
- Confirm `/api/health` reports `capabilities.paymentSettlement: true` after deployment before accepting PayOS callbacks.
- For opt-in real integration coverage, set `PAYMENT_REPLICA_SET_TEST_URI` to a disposable replica-set database whose name ends in `-test` or `_test`.

### 2. Python converter

```powershell
cd converter
python -m pip install -r requirements.txt
npm run dev
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

---

## API Endpoints

| Method | Endpoint           | Mô tả              | Access  |
| ------ | ------------------ | ------------------ | ------- |
| POST   | /api/auth/register | Đăng ký tài khoản  | Public  |
| POST   | /api/auth/login    | Đăng nhập          | Public  |
| GET    | /api/auth/me       | Lấy thông tin user | Private |
| GET    | /api/health        | Kiểm tra server    | Public  |

---

## Trang của ứng dụng

| Route       | Trang           |
| ----------- | --------------- |
| `/`         | Trang chủ       |
| `/login`    | Đăng nhập       |
| `/register` | Đăng ký         |
| `/pricing`  | Bảng giá        |
| `/contact`  | Liên hệ         |
| `/admin`    | Admin Dashboard |

---

## Tech Stack

**Frontend:** React 18, Vite, Tailwind CSS, Recharts, React Router v6, Axios, Lucide React

**Backend:** Node.js, Express.js, MongoDB, Mongoose, JWT, bcryptjs, express-validator
