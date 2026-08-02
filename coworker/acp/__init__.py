"""Agent Client Protocol adapters used by the QH orchestration control plane.

ACP is deliberately kept behind this package: the rest of the product works with persisted
profiles, session handles, normalized events, and artifacts instead of depending on one agent
implementation (OpenCode is merely the default profile).
"""

from .adapter import (
    AcpAgentAdapter,
    AcpEmptyTurnError,
    AcpMcpServer,
    AcpProcessExited,
    AcpSessionHandle,
    AcpTurnResult,
    PermissionRequest,
)
from .pi_rpc import PiJsonlRpcAdapter, PiRpcProtocolError, PiRpcTimeoutError

__all__ = [
    "AcpAgentAdapter",
    "AcpEmptyTurnError",
    "AcpMcpServer",
    "AcpProcessExited",
    "AcpSessionHandle",
    "AcpTurnResult",
    "PermissionRequest",
    "PiJsonlRpcAdapter",
    "PiRpcProtocolError",
    "PiRpcTimeoutError",
]
