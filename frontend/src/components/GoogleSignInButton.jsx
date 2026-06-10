import { useEffect, useRef, useState } from "react";

const GOOGLE_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

let googleScriptPromise;

const loadGoogleScript = () => {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (googleScriptPromise) return googleScriptPromise;

  googleScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector(
      `script[src="${GOOGLE_SCRIPT_SRC}"]`,
    );
    if (existingScript) {
      if (existingScript.dataset.loaded === "true") {
        resolve();
        return;
      }
      existingScript.addEventListener("load", resolve, { once: true });
      existingScript.addEventListener("error", reject, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = GOOGLE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });

  return googleScriptPromise;
};

const GoogleSignInButton = ({ onCredential, disabled = false }) => {
  const buttonRef = useRef(null);
  const [scriptError, setScriptError] = useState("");
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!clientId || disabled || !buttonRef.current) return undefined;

    let cancelled = false;

    loadGoogleScript()
      .then(() => {
        if (cancelled || !buttonRef.current) return;

        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response?.credential) {
              onCredential(response.credential);
            }
          },
        });

        buttonRef.current.innerHTML = "";
        window.google.accounts.id.renderButton(buttonRef.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "left",
          width: buttonRef.current.offsetWidth || 318,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setScriptError("Không tải được Google Sign-In");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [clientId, disabled, onCredential]);

  if (!clientId) {
    return (
      <button
        type="button"
        disabled
        className="w-full border border-gray-200 py-2.5 rounded-lg text-sm font-medium text-gray-400 cursor-not-allowed"
      >
        Google chưa được cấu hình
      </button>
    );
  }

  if (scriptError) {
    return (
      <button
        type="button"
        disabled
        className="w-full border border-red-200 bg-red-50 py-2.5 rounded-lg text-sm font-medium text-red-600 cursor-not-allowed"
      >
        {scriptError}
      </button>
    );
  }

  return (
    <div
      ref={buttonRef}
      aria-disabled={disabled}
      className={disabled ? "pointer-events-none opacity-60" : ""}
    />
  );
};

export default GoogleSignInButton;
