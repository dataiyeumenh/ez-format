const express = require("express");
const {
  createInternalConversionSessionController,
} = require("../controllers/internalConversionSessionController");

function routeHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      res.status(error?.statusCode || 500).json({
        success: false,
        code: error?.code || "INTERNAL_CONVERTER_SESSION_ERROR",
        message: error?.statusCode ? error.message : "Internal converter session failed",
      });
    }
  };
}

function createInternalConversionSessionsRouter(
  controller = createInternalConversionSessionController(),
) {
  const router = express.Router();
  router.put("/:sessionId/state", routeHandler(controller.putState));
  router.get("/:sessionId/state", routeHandler(controller.getState));
  router.put("/:sessionId/artifacts/:kind", routeHandler(controller.putArtifact));
  router.get("/:sessionId/artifacts/:kind", routeHandler(controller.getArtifact));
  router.delete("/:sessionId/artifacts/:kind", routeHandler(controller.deleteArtifact));
  return router;
}

const router = createInternalConversionSessionsRouter();

module.exports = router;
module.exports.createInternalConversionSessionsRouter =
  createInternalConversionSessionsRouter;
