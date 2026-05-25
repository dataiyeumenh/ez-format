const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/db");

require("dotenv").config();
connectDB();

const app = express();

// CORS config: allow localhost for dev + Vercel production URL
const allowedOrigins = [
  "http://localhost:5173", // Dev Vite
  "http://localhost:3000", // Dev alternative
  process.env.FRONTEND_URL, // Production (e.g., https://ezformat.io.vn)
  process.env.FRONTEND_URL_WWW, // www variant (e.g., https://www.ezformat.io.vn)
].filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/convert", require("./routes/convert"));

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", message: "EzFormat API is running" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
