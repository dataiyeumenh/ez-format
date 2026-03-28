# EzFormat - Chuẩn Hoá Dữ Liệu Kế Toán

Dự án chuyển đổi file kế toán sử dụng **MERN Stack** (MongoDB, Express, React, Node.js).

---

## Cấu trúc dự án

```
EXE101/
├── backend/      ← Node.js + Express + MongoDB
└── frontend/     ← React + Vite + Tailwind CSS
```

---

## Yêu cầu

- Node.js >= 18
- MongoDB (local hoặc MongoDB Atlas)

---

## Cài đặt & Chạy

### 1. Backend

```bash
cd backend
npm install

# Cấu hình môi trường
cp .env.example .env
# Sửa .env: MONGO_URI, JWT_SECRET

# Tạo tài khoản admin mặc định
npm run seed

# Chạy development
npm run dev
```

Backend chạy tại: `http://localhost:5000`

**Tài khoản Admin mặc định:**

- Email: `admin@ezformat.com`
- Password: `admin123456`

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend chạy tại: `http://localhost:5173`

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
