export function getPostLoginPath(user) {
  if (!user) return "/login";
  if (user.role === "admin") return "/admin";
  return user.isFirstLogin ? "/" : "/convert";
}
