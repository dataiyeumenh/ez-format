from __future__ import annotations

import ipaddress
import os
from urllib.parse import urlparse


def validate_remote_ai_endpoint(url: str) -> str:
    parsed = urlparse(str(url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("AI endpoint must use HTTP or HTTPS")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(
            "AI endpoint must not contain credentials, query, or fragment"
        )

    host = parsed.hostname.casefold().rstrip(".")
    allowlist = {"localhost", "127.0.0.1", "::1"}
    allowlist.update(
        item.strip().casefold().rstrip(".")
        for item in os.getenv("AI_PRIVATE_LOCAL_HOST_ALLOWLIST", "").split(",")
        if item.strip()
    )
    if _is_private_or_local_host(host):
        if host not in allowlist:
            raise ValueError("AI private/local host is not in allowlist")
    elif parsed.scheme != "https":
        raise ValueError("Remote AI endpoint requires HTTPS")
    return parsed.geturl()


def _is_private_or_local_host(host: str) -> bool:
    if host == "localhost" or host.endswith(
        (
            ".corp",
            ".home",
            ".internal",
            ".lan",
            ".local",
            ".localdomain",
            ".localhost",
        )
    ):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return "." not in host
    return bool(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
    )
