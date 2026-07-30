// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useStudentAssistantAvailability } from "./useStudentAssistantApi";

test("student availability skips backend capability lookup when the Vite flag is off", () => {
  const statusLoader = vi.fn();
  const { result } = renderHook(() =>
    useStudentAssistantAvailability({ frontendEnabled: false, statusLoader }),
  );

  expect(result.current).toBe(false);
  expect(statusLoader).not.toHaveBeenCalled();
});

test("student availability requires the enabled Vite flag and backend capability", async () => {
  const statusLoader = vi.fn().mockResolvedValue({
    serviceOnline: true,
    capabilityEnabled: true,
  });
  const { result } = renderHook(() =>
    useStudentAssistantAvailability({ frontendEnabled: true, statusLoader }),
  );

  await waitFor(() => expect(result.current).toBe(true));
  expect(statusLoader).toHaveBeenCalledTimes(1);
});
