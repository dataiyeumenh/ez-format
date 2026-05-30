const mongoose = require("mongoose");

const requireDb = (req, res, next) => {
  if (mongoose.connection.readyState === 1) {
    return next();
  }
  return res.status(503).json({
    success: false,
    message:
      "Cơ sở dữ liệu chưa sẵn sàng. Cấu hình MONGO_URI trong backend/.env và khởi động lại.",
  });
};

module.exports = requireDb;
