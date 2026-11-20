# Nexconn security checklist (Task 5.3)

Every row names the observation that proved it. Rows that are not proven are marked `Gap`, not
`Pass`. Cross-references point at `docs/nexconn-test-matrix.md`, where the same checks appear as
`SEC-1` … `SEC-8`.

| # | Control | Expected | Status | Evidence |
|---|---|---|---|---|
| 1 | App Secret never reaches the browser | The secret value appears in no built client chunk | Pass | `npm run build` exited 0; grepping the whole `.next` output for the secret value found 0 files and the `NEXCONN_APP_SECRET` name is absent from client chunks |
| 2 | App Key is not baked into the build | The key arrives only with the token response | Pass | the built bundle contains neither the key value nor a `NEXT_PUBLIC_NEXCONN_APP_KEY` reference; `GET /nexconn/token` returns it per session |
| 3 | `/nexconn/token` requires a Clerk session | `401` without one | Pass | `curl http://127.0.0.1:8123/nexconn/token` → `401` |
| 4 | Private-message routes require a session | `401` without one | Pass | `curl http://127.0.0.1:8123/dm/conversations` → `401`; also covered by `test_private_messages_require_sign_in` |
| 5 | Token responses are not cacheable | `Cache-Control: no-store` | Pass | set in `get_nexconn_token` before returning the per-user token (`routers/nexconn.py`) |
| 6 | Token issuance is rate limited | The limiter fires under a burst | Pass | 15 in-page requests with a live session gave 11 × `200` then 4 × `429` with `Retry-After: 60` (12 per minute, per user) |
| 7 | Only the app origin may call the API cross-origin | Foreign origins rejected | Pass | preflight with `Origin: https://evil.example` → `400`; `Origin: http://localhost:3000` → `200` |
| 8 | Disappearing-timer input matches the product rule | Values below 10 seconds rejected | Pass | `ConversationSettingsRequest` uses `seconds: int = Field(ge=10)` and the service re-validates; `PATCH …/settings` with `seconds: 5` → `422` |
| 9 | Calling is authorized by the server, not only hidden in the UI | A user with no conversation cannot start a call | Pass | `GET /nexconn/calls/authorize?peer_id=…` resolves the peer's Nexconn id back to a Clerk account and requires a shared conversation. Live with the demo session: the existing peer returned `200 {"allowed": true}`, the caller's own id and an unknown id returned `403`, and no session returned `401`. The UI gates on the same route and re-checks it before dialling, and with the route forced to `403` the Call button stayed disabled |
| 10 | Secrets stay out of logs | Provider errors are logged without credentials | Pass | `nexconn_server` logs HTTP status plus a trimmed provider message; the App Secret is used only to compute the signature and is never sent or logged |

## How call authorization works

`GET /nexconn/calls/authorize?peer_id=<nexconn id>` takes the id the browser already has, walks the
caller's own conversations and compares the derived Nexconn id of each recipient. The client-supplied
id is never trusted as an account: only a match inside the caller's own conversation list returns
`{"allowed": true, "conversation_id": …}`. Anything else is `403`, and the route requires the same
Clerk session as every other private route.

The Call button is a hint on top of that. `direct-messages-flow.tsx` asks the route when a thread
opens, keeps the button disabled unless it says yes, and asks again immediately before `startCall`,
so enabling calling in the console needs no further authorization work (`CALL-1` is only waiting on
the Nexconn audio/video service itself).

## Related evidence

- Load and restart evidence: `docs/load-test-baseline.json`, `docs/load-test-restart.json`,
  `backend/scripts/load_test_nexconn.py`.
- Mongo outage fallback: `test_private_messages_use_durable_local_store_when_mongo_is_unavailable`
  and `test_search_falls_back_when_mongo_fails_during_find`.
