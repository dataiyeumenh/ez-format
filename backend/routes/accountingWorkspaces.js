const express = require("express");
const multer = require("multer");
const requireDb = require("../middleware/requireDb");
const { protect } = require("../middleware/auth");
const {
  activateSnapshot,
  createConversionContext,
  createWorkspace,
  deleteSnapshot,
  deleteWorkspace,
  getWorkspace,
  importMasterData,
  listMasterData,
  listWorkspaces,
  saveAlias,
  searchMasterData,
  updateWorkspace,
} = require("../controllers/accountingWorkspaceController");

const router = express.Router();
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = String(file.originalname || "")
      .split(".")
      .pop()
      .toLowerCase();
    cb(
      ext === "xls" || ext === "xlsx"
        ? null
        : new Error("Chỉ chấp nhận file Excel (.xls, .xlsx)"),
      ext === "xls" || ext === "xlsx",
    );
  },
});

router.use(requireDb, protect);
router.get("/", asyncRoute(listWorkspaces));
router.post("/", asyncRoute(createWorkspace));
router.get("/:id", asyncRoute(getWorkspace));
router.patch("/:id", asyncRoute(updateWorkspace));
router.delete("/:id", asyncRoute(deleteWorkspace));
router.get("/:id/master-data", asyncRoute(listMasterData));
router.get("/:id/master-data/search", asyncRoute(searchMasterData));
router.post(
  "/:id/master-data/imports",
  upload.single("file"),
  asyncRoute(importMasterData),
);
router.post(
  "/:id/master-data/snapshots/:snapshotId/activate",
  asyncRoute(activateSnapshot),
);
router.delete(
  "/:id/master-data/snapshots/:snapshotId",
  asyncRoute(deleteSnapshot),
);
router.post("/:id/aliases", asyncRoute(saveAlias));
router.post("/:id/conversion-context", asyncRoute(createConversionContext));

router.use((error, _req, res, _next) => {
  const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 500;
  res.status(status).json({
    success: false,
    message:
      status === 413
        ? "File danh mục vượt quá giới hạn 20 MB"
        : error.message || "Không thể xử lý danh mục MISA",
  });
});

module.exports = router;
