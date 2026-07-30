// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { studentAvailable } = vi.hoisted(() => ({
  studentAvailable: vi.fn(),
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: null, logout: vi.fn(), isAdmin: () => false }),
}));
vi.mock("../hooks/useStudentAssistantApi", () => ({
  studentAssistantEnabled: true,
  useStudentAssistantAvailability: studentAvailable,
}));

const { default: Navbar } = await import("./Navbar.jsx");

beforeEach(() => studentAvailable.mockReset());
afterEach(cleanup);

test("desktop and mobile student links stay hidden without backend capability", async () => {
  studentAvailable.mockReturnValue(false);
  const user = userEvent.setup();
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Navbar />
    </MemoryRouter>,
  );

  expect(screen.queryByRole("link", { name: "Sinh viên" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Menu" }));
  expect(screen.queryByRole("link", { name: "Sinh viên" })).toBeNull();
});

test("desktop and mobile student links render when Vite flag and backend capability pass", async () => {
  studentAvailable.mockReturnValue(true);
  const user = userEvent.setup();
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Navbar />
    </MemoryRouter>,
  );

  expect(screen.getAllByRole("link", { name: "Sinh viên" })).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Menu" }));
  expect(screen.getAllByRole("link", { name: "Sinh viên" })).toHaveLength(2);
});
