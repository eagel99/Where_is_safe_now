# Security

## Action engine

- Keep `ACTIONS_ENABLED=false` until rules have been tested.
- Use `ACTION_ALLOWED_HOSTS` for every external webhook host.
- Configure a long random `ACTION_HMAC_SECRET` and verify it at the receiver.
- The receiver must enforce `Idempotency-Key` in durable storage.
- Do not place credentials, payment information or API secrets in `actions.json`.
- Put secrets in environment variables or a secret manager.
- Use a separate service account with minimum permissions.
- Keep irreversible actions disabled unless the workflow has a sandbox, strict rate limits and human review.

## HTTP server

The dashboard has public read endpoints by design. Put it behind authentication or a private network when exposing it to the internet. Administrative POST endpoints require `ADMIN_TOKEN`, but the reverse proxy should still apply authentication and rate limits.

## Data

Raw alert samples are persisted in `.data/events.jsonl`. Restrict filesystem permissions and retention according to your deployment requirements.
