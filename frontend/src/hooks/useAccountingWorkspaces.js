import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "../services/api";

const STORAGE_KEY = "ezformat_accounting_workspace_id";
const WORKSPACES_ENABLED =
  String(
    import.meta.env.VITE_MASTER_DATA_WORKSPACES_ENABLED || "true",
  ).toLowerCase() !== "false";

export function useAccountingWorkspaces() {
  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWorkspaceId, setSelectedWorkspaceIdState] = useState(
    () => localStorage.getItem(STORAGE_KEY) || "",
  );
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(WORKSPACES_ENABLED);
  const [masterDataLoading, setMasterDataLoading] = useState(false);
  const [error, setError] = useState("");
  const masterDataRequestRef = useRef(0);

  const selectedWorkspace = useMemo(
    () => workspaces.find((item) => item.id === selectedWorkspaceId) || null,
    [selectedWorkspaceId, workspaces],
  );

  const setSelectedWorkspaceId = useCallback((value) => {
    const id = value || "";
    setSelectedWorkspaceIdState(id);
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const loadWorkspaces = useCallback(async () => {
    if (!WORKSPACES_ENABLED) {
      setWorkspaces([]);
      setLoading(false);
      return [];
    }
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get("/accounting-workspaces");
      const items = data.items || [];
      setWorkspaces(items);
      setSelectedWorkspaceIdState((current) => {
        const next = items.some((item) => item.id === current)
          ? current
          : items.length === 1
            ? items[0].id
            : "";
        if (next) localStorage.setItem(STORAGE_KEY, next);
        else localStorage.removeItem(STORAGE_KEY);
        return next;
      });
      return items;
    } catch (requestError) {
      setError(
        requestError.response?.data?.message ||
          requestError.message ||
          "Không thể tải hồ sơ doanh nghiệp.",
      );
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMasterData = useCallback(async (workspaceId) => {
    const requestId = ++masterDataRequestRef.current;
    if (!WORKSPACES_ENABLED || !workspaceId) {
      setSnapshots([]);
      setMasterDataLoading(false);
      return [];
    }
    setMasterDataLoading(true);
    setError("");
    try {
      const { data } = await api.get(
        `/accounting-workspaces/${workspaceId}/master-data`,
      );
      const items = data.snapshots || [];
      if (requestId === masterDataRequestRef.current) setSnapshots(items);
      return items;
    } catch (requestError) {
      if (requestId === masterDataRequestRef.current) {
        setError(requestError.response?.data?.message || requestError.message);
      }
      throw requestError;
    } finally {
      if (requestId === masterDataRequestRef.current) setMasterDataLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    loadMasterData(selectedWorkspaceId).catch(() => {});
  }, [loadMasterData, selectedWorkspaceId]);

  const createWorkspace = useCallback(
    async (payload) => {
      if (!WORKSPACES_ENABLED) throw new Error("Hồ sơ doanh nghiệp đang tắt");
      const { data } = await api.post("/accounting-workspaces", payload);
      await loadWorkspaces();
      setSelectedWorkspaceId(data.workspace.id);
      return data.workspace;
    },
    [loadWorkspaces, setSelectedWorkspaceId],
  );

  const importCatalog = useCallback(
    async (workspaceId, type, file) => {
      const form = new FormData();
      form.append("type", type);
      form.append("file", file);
      const { data } = await api.post(
        `/accounting-workspaces/${workspaceId}/master-data/imports`,
        form,
      );
      await loadMasterData(workspaceId);
      return data.snapshot;
    },
    [loadMasterData],
  );

  const searchCatalog = useCallback(async (workspaceId, type, query) => {
    const { data } = await api.get(
      `/accounting-workspaces/${workspaceId}/master-data/search`,
      { params: { type, q: query, limit: 30 } },
    );
    return data.items || [];
  }, []);

  const activateSnapshot = useCallback(
    async (workspaceId, snapshotId) => {
      const { data } = await api.post(
        `/accounting-workspaces/${workspaceId}/master-data/snapshots/${snapshotId}/activate`,
      );
      await Promise.all([loadMasterData(workspaceId), loadWorkspaces()]);
      return data.snapshot;
    },
    [loadMasterData, loadWorkspaces],
  );

  const saveAlias = useCallback(
    async (workspaceId, payload) => {
      const { data } = await api.post(
        `/accounting-workspaces/${workspaceId}/aliases`,
        payload,
      );
      await loadWorkspaces();
      return data.alias;
    },
    [loadWorkspaces],
  );

  const createConversionContext = useCallback(async (workspaceId, conversionRunId) => {
    if (!workspaceId) return null;
    const { data } = await api.post(
      `/accounting-workspaces/${workspaceId}/conversion-context`,
      { conversion_run_id: conversionRunId },
    );
    return data;
  }, []);

  return {
    enabled: WORKSPACES_ENABLED,
    workspaces,
    selectedWorkspace,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    snapshots,
    loading,
    masterDataLoading,
    error,
    createWorkspace,
    importCatalog,
    searchCatalog,
    activateSnapshot,
    saveAlias,
    createConversionContext,
    reload: loadWorkspaces,
  };
}
