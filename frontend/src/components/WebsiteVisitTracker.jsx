import { useEffect } from "react";
import api from "../services/api";

const VISIT_SESSION_KEY = "ezformat:website-visit-recorded";

function WebsiteVisitTracker() {
  useEffect(() => {
    try {
      if (sessionStorage.getItem(VISIT_SESSION_KEY)) return;
      sessionStorage.setItem(VISIT_SESSION_KEY, "pending");
    } catch {
      return;
    }

    api
      .post("/analytics/visit")
      .then(() => sessionStorage.setItem(VISIT_SESSION_KEY, "recorded"))
      .catch(() => sessionStorage.removeItem(VISIT_SESSION_KEY));
  }, []);

  return null;
}

export default WebsiteVisitTracker;
