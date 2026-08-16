# Agent 1

TopUni / TopApp engineering and research agent.

## Modes
- Research
- Code
- Fix Bug
- Test
- University Data
- Audit

## Safety
Agent 1 analyzes repositories before editing, installs dependencies before validation, rejects unrelated package/configuration edits, makes minimal changes, runs validation, and only publishes to `main` when explicitly approved.

## Environment variables
See `.env.example`. Do not commit real credentials.

## Runtime
Uses structured Gemini responses with schema validation before repository edits and a validation/repair loop before creating a GitHub pull request.
