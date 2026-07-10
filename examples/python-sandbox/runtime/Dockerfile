# Reference image for the python-sandbox example. Not built or shipped
# from this repo — the example uses the mock gateway by default. This
# file shows the shape a real CF Container image would take: read JSON
# from stdin, eval the `code` field, write JSON to stdout.

FROM python:3.12-slim

# A real deployment should drop privileges further (non-root user,
# read-only filesystem, no network), and may want to add a seccomp
# profile that whitelists only the syscalls the evaluator needs.
WORKDIR /app
COPY evaluator.py /app/evaluator.py

# The container is "one shot per call": the gateway invokes it once per
# tool call and reads stdout. Long-lived service-mode is also fine —
# either way the wire format on /run is the gateway's concern, not the
# image's.
ENTRYPOINT ["python", "/app/evaluator.py"]
