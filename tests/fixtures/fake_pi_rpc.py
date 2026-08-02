from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any


def _log(kind: str, payload: dict[str, Any]) -> None:
    path = os.environ.get("PI_FAKE_LOG")
    if not path:
        return
    with Path(path).open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"kind": kind, **payload}, sort_keys=True) + "\n")


def _send(frame: dict[str, Any]) -> None:
    ending = "\r\n" if os.environ.get("PI_FAKE_CRLF") else "\n"
    sys.stdout.write(json.dumps(frame, separators=(",", ":"), sort_keys=True) + ending)
    sys.stdout.flush()


async def _main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode")
    parser.add_argument("--session")
    args = parser.parse_args()

    session_file = args.session or f"session-{uuid.uuid4().hex}.json"
    prompt_task: asyncio.Task[None] | None = None

    async def complete_prompt(request_id: int, prompt: str) -> None:
        _send({"id": request_id, "type": "response", "command": "prompt", "success": True})
        if prompt == "crash":
            os._exit(7)
        if prompt == "slow":
            await asyncio.Event().wait()
        else:
            await asyncio.sleep(0.03 if prompt == "one" else 0.01)
            for chunk in (f"{prompt}:", "ok"):
                _send(
                    {
                        "type": "message_update",
                        "message": {},
                        "assistantMessageEvent": {
                            "type": "text_delta",
                            "contentIndex": 0,
                            "delta": chunk,
                            "partial": {},
                        },
                    }
                )
            _send({"type": "agent_settled", "stop_reason": "end_turn"})

    _log("argv", {"argv": sys.argv[1:]})
    while True:
        line = await asyncio.to_thread(sys.stdin.buffer.readline)
        if not line:
            break
        _log("raw", {"line": line.decode("utf-8")})
        frame = json.loads(line)
        request_id = frame["id"]
        command = frame.get("type")

        if command == "get_state":
            _send(
                {
                    "id": request_id,
                    "type": "response",
                    "command": "get_state",
                    "success": True,
                    "data": {"sessionFile": session_file},
                }
            )
        elif command == "switch_session":
            session_file = frame["sessionPath"]
            _send(
                {
                    "id": request_id,
                    "type": "response",
                    "command": "switch_session",
                    "success": True,
                }
            )
        elif command == "prompt":
            prompt_task = asyncio.create_task(complete_prompt(request_id, frame["message"]))
        elif command == "abort":
            if prompt_task is not None:
                prompt_task.cancel()
            _send({"id": request_id, "type": "response", "command": "abort", "success": True})
            _send({"type": "agent_settled", "stop_reason": "aborted"})
        else:
            _send(
                {
                    "id": request_id,
                    "type": "response",
                    "command": command,
                    "success": False,
                    "error": {"message": f"unknown command {command}"},
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
