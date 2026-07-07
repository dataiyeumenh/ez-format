import { createContext, useCallback, useContext, useState, useEffect } from "react";
import api from "../services/api";

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem("token"));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initAuth = () => {
      const storedToken = localStorage.getItem("token");
      const storedUser = localStorage.getItem("user");
      if (storedToken && storedUser) {
        try {
          setToken(storedToken);
          setUser(JSON.parse(storedUser));
        } catch {
          localStorage.removeItem("token");
          localStorage.removeItem("user");
        }
      }
      setLoading(false);
    };
    initAuth();
  }, []);

  const login = useCallback(async (email, password) => {
    const response = await api.post("/auth/login", { email, password });
    const { token, user, isFirstLogin } = response.data;
    const sessionUser = {
      ...user,
      isFirstLogin: Boolean(isFirstLogin ?? user?.isFirstLogin),
    };
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(sessionUser));
    setToken(token);
    setUser(sessionUser);
    return sessionUser;
  }, []);

  const register = useCallback(async (name, email, password) => {
    const response = await api.post("/auth/register", {
      name,
      email,
      password,
    });
    return response.data?.user;
  }, []);

  const loginWithGoogle = useCallback(async (credential) => {
    const response = await api.post("/auth/google", { credential });
    const { token, user, isFirstLogin } = response.data;
    const sessionUser = {
      ...user,
      isFirstLogin: Boolean(isFirstLogin ?? user?.isFirstLogin),
    };
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(sessionUser));
    setToken(token);
    setUser(sessionUser);
    return sessionUser;
  }, []);

  const refreshUser = useCallback(async () => {
    const response = await api.get("/auth/me");
    const { user } = response.data;
    localStorage.setItem("user", JSON.stringify(user));
    setUser(user);
    return user;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setToken(null);
    setUser(null);
  }, []);

  const isAdmin = () => user?.role === "admin";

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        login,
        register,
        loginWithGoogle,
        refreshUser,
        logout,
        isAdmin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with provider
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
};
