// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { apiPost, navigate } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../services/api", () => ({ default: { post: apiPost } }));
vi.mock("react-router-dom", () => ({
  useLocation: () => ({
    state: {
      planId: "perfile-plan",
      planCode: "perfile",
      plan: { code: "perfile", name: "Per-file", price: 10000, fileCredits: 1 },
    },
  }),
  useNavigate: () => navigate,
}));
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "contract-user" } }),
}));
vi.mock("../components/Navbar", () => ({ default: () => null }));
vi.mock("../components/Footer", () => ({ default: () => null }));

const { default: PaymentPage } = await import("./PaymentPage.jsx");

beforeEach(() => {
  apiPost.mockReset();
  navigate.mockReset();
});

afterEach(cleanup);

test("payment UI applies a coupon then sends it when creating payment", async () => {
  apiPost
    .mockResolvedValueOnce({
      data: {
        coupon: { code: "SAVE10", description: "Ten percent", discountPercent: 10 },
        discountAmount: 1000,
        finalAmount: 9000,
        originalAmount: 10000,
      },
    })
    .mockResolvedValueOnce({ data: {} });
  const user = userEvent.setup();

  render(createElement(PaymentPage));
  await user.type(screen.getByPlaceholderText("Nhập mã coupon"), "save10");
  await user.click(screen.getByRole("button", { name: "Áp dụng" }));

  await waitFor(() => {
    expect(apiPost).toHaveBeenNthCalledWith(1, "/payments/preview-coupon", {
      planId: "perfile-plan",
      planCode: "perfile",
      couponCode: "SAVE10",
    });
  });
  expect(screen.getByRole("button", { name: "Gỡ" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: /thanh toán/i }));

  await waitFor(() => {
    expect(apiPost).toHaveBeenNthCalledWith(2, "/payments/create", {
      planId: "perfile-plan",
      planCode: "perfile",
      couponCode: "SAVE10",
    });
  });
});
