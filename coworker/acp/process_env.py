"""Least-privilege environment construction for local agent subprocesses."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any, Optional


_SAFE_KEYS = {
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "SHELL",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
}
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def build_agent_env(
    profile: Any,
    *,
    resolved_secrets: Optional[Mapping[str, str]] = None,
) -> dict[str, str]:
    """Return a minimal child environment plus explicitly declared values.

    Ambient credentials are intentionally excluded. ``secret_refs`` are treated as
    environment-variable names and are copied only when explicitly listed. A caller may
    supply ``resolved_secrets`` to avoid consulting the ambient environment at all.
    Reviewer/explorer/read-only profiles never receive secret refs.
    """

    env = build_minimal_env()
    declared_env = _profile_value(profile, "env", {}) or {}
    if isinstance(declared_env, Mapping):
        env.update({str(key): str(value) for key, value in declared_env.items()})

    role = _enum_value(_profile_value(profile, "role", "main"))
    policy = str(_profile_value(profile, "permission_policy", "coding-default"))
    if role in {"reviewer", "explorer"} or policy in {
        "read-only",
        "reviewer-read-only",
    }:
        return env

    supplied = resolved_secrets or {}
    for raw_ref in _profile_value(profile, "secret_refs", []) or []:
        ref = str(raw_ref)
        if not _ENV_NAME.fullmatch(ref):
            continue
        if ref in supplied:
            env[ref] = str(supplied[ref])
        elif ref in os.environ:
            env[ref] = os.environ[ref]
    return env


def build_minimal_env() -> dict[str, str]:
    """Return the credential-free ambient environment allowed for host subprocesses."""

    return {
        key: value
        for key, value in os.environ.items()
        if key in _SAFE_KEYS and isinstance(value, str)
    }


def _profile_value(profile: Any, key: str, default: Any) -> Any:
    if isinstance(profile, Mapping):
        return profile.get(key, default)
    return getattr(profile, key, default)


def _enum_value(value: Any) -> str:
    return str(getattr(value, "value", value))


__all__ = ["build_agent_env", "build_minimal_env"]
