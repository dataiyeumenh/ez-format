const express = require("express");

const router = express.Router();

function legacyConvertGone(_req, res) {
  return res.status(410).json({
    success: false,
    code: "LEGACY_CONVERT_GONE",
    message:
      "Legacy /api/convert is retired. Use the authenticated converter flow at /api/converter.",
    migration_endpoint: "/api/converter",
  });
}

router.all("*", legacyConvertGone);

module.exports = router;
