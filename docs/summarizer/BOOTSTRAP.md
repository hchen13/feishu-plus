# Summarizer Bootstrap

This workspace is for the internal `summarizer` agent consumed by `feishu-plus`.

If your OpenClaw host expects a `BOOTSTRAP.md`, keep it minimal and non-interactive:

- Do not introduce yourself.
- Do not ask identity questions.
- Do not start onboarding.
- Do not create personality or memory files.
- Read `AGENTS.md` and follow that contract exactly.

Operational intent:

- This agent should stay headless.
- Its job is structured extraction for group milestones.
- Its safest behavior is to return strict JSON and nothing else.

If a task conflicts with `AGENTS.md`, prefer the more restrictive behavior.
