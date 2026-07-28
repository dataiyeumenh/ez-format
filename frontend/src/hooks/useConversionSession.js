import { useCallback, useMemo, useReducer } from "react";
import {
  buildMutationContext,
  createOperationSessionState,
  operationSessionReducer,
} from "../utils/operationSession.js";

export function useConversionSession() {
  const [state, dispatch] = useReducer(
    operationSessionReducer,
    undefined,
    createOperationSessionState,
  );

  const setAnalysis = useCallback((payload) => {
    dispatch({ type: "analysis_ready", payload });
  }, []);
  const startOperation = useCallback((operation) => {
    dispatch({ type: "operation_started", operation });
  }, []);
  const finishOperation = useCallback((operation, payload, announcement = "") => {
    dispatch({ type: "operation_succeeded", operation, payload, announcement });
  }, []);
  const failOperation = useCallback((operation, error, options = {}) => {
    dispatch({
      type: "operation_failed",
      operation,
      error,
      optional: options.optional === true,
    });
  }, []);
  const markStale = useCallback((message) => {
    dispatch({ type: "mark_stale", message });
  }, []);
  const clearNotice = useCallback(() => dispatch({ type: "clear_notice" }), []);
  const resetSession = useCallback(() => dispatch({ type: "reset" }), []);
  const syncSession = useCallback((payload) => {
    dispatch({ type: "session_synced", payload });
  }, []);

  const mutationContext = useMemo(
    () => buildMutationContext(state.session),
    [state.session],
  );

  return {
    ...state,
    mutationContext,
    setAnalysis,
    startOperation,
    finishOperation,
    failOperation,
    markStale,
    clearNotice,
    resetSession,
    syncSession,
  };
}

export default useConversionSession;
