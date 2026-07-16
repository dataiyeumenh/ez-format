import { useState } from "react";
import { Building2, Loader2, X } from "lucide-react";

export default function WorkspaceSetupModal({ open, onClose, onCreate }) {
  const [form, setForm] = useState({ name: "", taxCode: "", misaProduct: "AMIS" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const submit = async (event) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onCreate({ ...form, name: form.name.trim(), taxCode: form.taxCode.trim() });
      setForm({ name: "", taxCode: "", misaProduct: "AMIS" });
      onClose();
    } catch (requestError) {
      setError(requestError.response?.data?.message || requestError.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-gray-950/45 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-setup-title"
        className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <div className="rounded-2xl bg-primary-50 p-3 text-primary-600">
              <Building2 size={22} />
            </div>
            <div>
              <h2
                id="workspace-setup-title"
                className="text-xl font-black text-gray-900"
              >
                Tạo hồ sơ doanh nghiệp
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                Dùng để tách danh mục và setting MISA giữa các doanh nghiệp.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"
            aria-label="Đóng"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block text-sm font-semibold text-gray-700">
            Tên doanh nghiệp
            <input
              autoFocus
              required
              value={form.name}
              onChange={(event) =>
                setForm((current) => ({ ...current, name: event.target.value }))
              }
              className="mt-1.5 w-full rounded-xl border border-gray-200 px-3 py-2.5 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              placeholder="Công ty TNHH..."
            />
          </label>
          <label className="block text-sm font-semibold text-gray-700">
            Mã số thuế
            <input
              value={form.taxCode}
              onChange={(event) =>
                setForm((current) => ({ ...current, taxCode: event.target.value }))
              }
              className="mt-1.5 w-full rounded-xl border border-gray-200 px-3 py-2.5 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              placeholder="0317262773"
            />
          </label>
          <label className="block text-sm font-semibold text-gray-700">
            Phần mềm MISA
            <select
              value={form.misaProduct}
              onChange={(event) =>
                setForm((current) => ({ ...current, misaProduct: event.target.value }))
              }
              className="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5"
            >
              <option value="AMIS">MISA AMIS</option>
              <option value="SME">MISA SME</option>
            </select>
          </label>
          {error && (
            <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Hủy
            </button>
            <button
              type="submit"
              disabled={saving || !form.name.trim()}
              className="btn-primary"
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              Tạo hồ sơ
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
