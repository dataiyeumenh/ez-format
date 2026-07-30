const mongoose = require("mongoose");

const mappingProfileV2MigrationAuditSchema = new mongoose.Schema(
  {
    migrationId: { type: String, required: true, trim: true, maxlength: 160 },
    runId: { type: String, required: true, trim: true, maxlength: 160 },
    operation: { type: String, enum: ["apply", "rollback"], required: true },
    targetRunId: { type: String, trim: true, maxlength: 160, default: null },
    status: { type: String, enum: ["completed"], required: true },
    report: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true, autoIndex: false },
);

mappingProfileV2MigrationAuditSchema.index({ runId: 1 }, { unique: true });
mappingProfileV2MigrationAuditSchema.index({ migrationId: 1, createdAt: -1 });

module.exports = mongoose.model(
  "MappingProfileV2MigrationAudit",
  mappingProfileV2MigrationAuditSchema,
);
