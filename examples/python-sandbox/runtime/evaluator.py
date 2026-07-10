"""Minimal stdin-to-stdout Python evaluator. Reads one JSON request,
prints one JSON response, exits. Designed to be invoked once per tool
call by the gateway Worker.

Request shape:
  { "code": "print('hi')" }

Response shape:
  { "content": "<captured stdout>", "exit_code": 0 }
  { "content": "<partial>", "exit_code": 1, "stderr": "<exception>" }

Real deployment must add resource limits (RLIMIT_AS, RLIMIT_CPU), drop
privileges, and disable network — none of which we attempt here. This
file is the *shape* of the runtime, not a production-ready evaluator.
"""

import io
import json
import sys
import traceback
from contextlib import redirect_stdout


def main() -> None:
    try:
        req = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        print(json.dumps({"content": "", "exit_code": 1, "stderr": f"bad request: {e}"}))
        return

    code = req.get("code", "")
    if not isinstance(code, str) or not code.strip():
        print(json.dumps({"content": "", "exit_code": 1, "stderr": "no code supplied"}))
        return

    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            exec(code, {"__name__": "__main__"})
        print(json.dumps({"content": buf.getvalue(), "exit_code": 0}))
    except Exception:
        partial = buf.getvalue()
        print(
            json.dumps(
                {
                    "content": partial,
                    "exit_code": 1,
                    "stderr": traceback.format_exc(limit=4),
                }
            )
        )


if __name__ == "__main__":
    main()
