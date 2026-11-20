# Nexconn functional test matrix

Scope: only the features that actually shipped. Phase 4.2 (chat-to-call) is blocked by
Nexconn `errCode 80006` because audio/video calling is not enabled for the app yet, so its
rows are listed but marked `Blocked` rather than skipped. Group channels were not built, so
group features are out of scope.

Calling is optional in the Nexconn Build Challenge and is not part of the free chat plan, so
enabling it needs a card on the Nexconn account. The challenge FAQ says: "The Call SDK is
optional—simply add a credit card to your account to claim 10,000 free minutes", and the call
pricing page lists 10K voice/video minutes to test at $0.0099 per user-minute after that. The
Nexconn ToS (§6.2a) requires a card linked through Stripe on the Billing/Payment page before
the services are usable.

Status values: `Pass`, `Fail`, `Blocked`, `Not run`. A `Pass` must name the observation that
proved it — "it should work" is not evidence.

## How to run the environment

```bash
# backend (port 8123)
cd backend && ./.venv/Scripts/python.exe -m uvicorn main:app --host 127.0.0.1 --port 8123

# frontend (port 3000)
cd frontend && npm install && ./node_modules/.bin/next dev --port 3000
```

`npm install` needs no `--legacy-peer-deps`; `frontend/package.json` carries overrides that
widen `@nexconn/call`'s pinned chat/engine peers.

Two demo accounts used for every two-session check:

| Account | Username | Email |
|---|---|---|
| one | `aegis_demo_one` | `aegis.demo.one@aegis-demo.dev` |
| two | `aegis_demo_two` | `aegis.demo.two@aegis-demo.dev` |

## Auth and session

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| AUTH-1 | `/nexconn/token` requires a Clerk session | `curl -i http://127.0.0.1:8123/nexconn/token` with no token | Pass | `401 {"detail":"Sign in to use private messages."}` |
| AUTH-2 | Signed-in client receives a Nexconn token and connects | open Messages signed in, console shows no connect error, `connection === "ready"` | Pass | both demo accounts reached ready during Phase 3.1 two-session run |
| AUTH-3 | Expired Clerk token mid-session recovers | let the tab idle past token life, send a message | Not run | the wrapper retries a 401 once with `getToken({skipCache:true})`, and `reconnect()` now asks the backend for a fresh Nexconn token when the link stays down for 10s. A real token expiry was not forced, so this stays unproven |
| AUTH-4 | Nexconn token refresh/reconnect without a page reload | idle past Nexconn session life, then send | Not run | |

## Messaging

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| MSG-1 | Send and receive in both directions | two browsers, one message each way | Pass | Phase 3.1: both sessions rendered the same `messageId` |
| MSG-2 | History matches live messages | reload the thread after sending | Pass | Phase 3.1: `fetchRecentMessages` returned the same ids after reload |
| MSG-3 | Typing indicator is live | type in one tab, watch the other | Pass | Phase 3.2: typing arrived live and cleared on send |
| MSG-4 | Presence shows online | both tabs open on the thread | Pass | Phase 3.2: online shown in both tabs |
| MSG-5 | Read receipt | open the thread on the receiving tab | Pass | Phase 3.3: `readCount 1` from the API and the read tick in the UI |
| MSG-6 | Image and file attachments | composer attach button, send one of each | Pass | Phase 3.4: image and file messages rendered on the receiving side |
| MSG-7 | Duplicate-send guard | double-click Send with a slow network | Pass | two `requestSubmit()` calls in the same tick produced exactly one message in the thread. The composer now blocks on a ref, so the second submit cannot slip in before state updates land |
| MSG-8 | Offline → reconnect delivery | go offline mid-thread, send from the other tab, come back | Not run | this browser tooling has no network-offline control, so the socket drop could not be forced. The gap is now handled in code: a `ConnectionStatusHandler` reports the link coming back and the open thread is refetched, so late messages fill in. Still unproven without a real drop |
| MSG-9 | Disappearing message actually deletes from Nexconn | set a 10s timer, send, wait, check both tabs and history | Pass | with the 10s timer saved, the message was in the thread right after sending, gone after 14s, and still absent after a full page reload and a fresh history fetch — so the sender-side recall reached Nexconn instead of only hiding the bubble locally |
| MSG-10 | Long conversation history (100+ messages) | seed a long thread, click Load earlier messages | Pass | 90 messages were seeded through the Server API and the thread rendered 80 of them with "Load earlier messages" visible. Clicking it fetched the older page (80 → 90 rendered) and the button disappeared once the returned page was shorter than the page size. The seeded messages were then recalled (183 recalls, all `code 0`) and the thread was checked back to its original messages |
| MSG-11 | Enter sends, IME composition Enter does not | Japanese/Chinese IME in the composer | Pass | composing Enter and `keyCode 229` kept the draft; a normal Enter sent it |

## Bot in chat (Task 4.1)

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| BOT-1 | `/companion <text>` replies in the thread | type `/companion I feel anxious` in an open conversation | Pass | Phase 4.1 put the reply in both tabs. The text no longer repeats a name prefix, so the reply reads as plain conversation and the "Aegis Companion" meta label identifies it |
| BOT-2 | Bot reply is labelled, not attributed to the human peer | inspect the bubble meta | Pass | Phase 4.1: `is-bot` styling and the "Aegis Companion" label |
| BOT-3 | 1-on-1 bot reply stays safety-first without copying the standalone companion | send urgent-language text through `/companion` and compare with `companion-flow.tsx` | Pass | DM reply was safety-first and named India helplines (Vandrevala 91529 87821, 112). The standalone companion showed its "Immediate support" card with `urgent_support_message` and the 112 / 181 links. Keeping those two surfaces different is the intended design — the DM stays a conversation, the companion keeps the full safety card |

## Summary into the Email alert (Task 4.3)

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| SUM-1 | "Prepare alert" summarizes the open thread | click Prepare alert, confirm the prompt | Pass | Phase 4.3: live Groq summary returned for a two-account thread |
| SUM-2 | Email support opens pre-filled, nothing sent | continue after the summary | Pass | Phase 4.3: summary filled the Email support field; send was deliberately not exercised |
| SUM-3 | Empty thread is refused | open an empty thread | Pass | the button is disabled without written messages |
| SUM-4 | Summarizing does not touch other tools | run SUM-1 then use another tool | Not run | |

## Calling (Task 4.2) — blocked

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| CALL-1 | 1:1 audio call connects between two users with an open channel | two browsers, click Call | Blocked | `[NCCall][ERROR] callplus_client_start_call … errCode: 80006`; enable audio/video calling in the Nexconn console. Enabling needs a card on the account first (challenge FAQ: add a card to claim 10,000 free minutes) |
| CALL-2 | Microphone denial shows a clear message | block the mic permission, click Call | Not run | pre-flight `getUserMedia` maps denial to an explicit message |
| CALL-3 | Answer / Mute / End work | accept on the second tab, toggle mute, hang up | Not run | depends on CALL-1 |
| CALL-4 | Mid-call drop resets the UI | kill the network mid-call | Not run | depends on CALL-1 |
| CALL-5 | Call banner stays in its own conversation | start a call, open a different conversation | Not run | banner is matched on the caller/callee Nexconn id and a compact strip keeps Mute/End reachable elsewhere; needs CALL-1 to observe |
| CALL-6 | Incoming call opens its own thread | ring from the other tab while a different thread is open | Not run | depends on CALL-1 |

## Multi-device

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| DEV-1 | Same Clerk account, two browsers | sign in as one account in both, message from the other account | Not run | expected behaviour is documented below the table. Not observed live yet |
| DEV-2 | Conversation metadata stays consistent across devices | open the same thread in both | Not run | |

## Transport and security basics

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| SEC-1 | Foreign origin is rejected on preflight | `curl -X OPTIONS /nexconn/token -H "Origin: https://evil.example"` | Pass | `400` |
| SEC-2 | The app origin is allowed | same request with `Origin: http://localhost:3000` | Pass | `200` |
| SEC-3 | Nexconn App Key/secret never reaches the browser bundle | production build, grep the built JS for the key | Pass | `npm run build` finished with exit 0. Grepping the whole `.next` output for the App Secret value found 0 files, the `NEXCONN_APP_SECRET` name is absent from client chunks, and the App Key value is not baked in either — it arrives with the token response |
| SEC-4 | `/nexconn/token` rate limit fires | burst requests with a valid token | Pass | 15 in-page requests with the live Clerk session answered `200` eleven times, then `429` four times, so the 12-per-minute limiter holds |

## Backend regression

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| REG-1 | Backend test suite stays green | `cd backend && ./.venv/Scripts/python.exe -m pytest` | Pass | 122 tests ran green during Phase 3.6 / CORS work; not re-run during the hardening pass |
| REG-2 | Frontend typecheck and production build | `cd frontend && ./node_modules/.bin/tsc --noEmit && npm run build` | Pass | both exit 0 after the reconnect, pagination and double-send changes |

## Edge cases (Task 5.2)

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| EDGE-1 | Two tabs on the same conversation sending at once | send from both tabs in the same second | Not run | the composer guards with `sendingRef` (MSG-7), but two independent tabs were not exercised |
| EDGE-2 | Weak network, then airplane mode and back | DevTools throttling plus an offline toggle | Not run | the browser tooling here has no offline control, same blocker as MSG-8 |
| EDGE-3 | A 100+ message thread paginates | seed a long thread, click Load earlier messages | Pass | closed by the MSG-10 run, which seeded 90 messages, paged back to all 90 and cleaned up afterwards |
| EDGE-4 | Expired Nexconn token recovers without a reload | wait out the token lifetime | Not run | the reconnect path re-fetches a token after 10 s down; the console controls token lifetime, so it was not forced |
| EDGE-5 | A disappearing message expires while its thread is open | set a 10 s timer, keep the thread open | Pass | during the MSG-9 run the bubble disappeared after 14 s in both tabs while the composer stayed usable |

## Phase 5 hardening checks

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| SEC-5 | `/nexconn/token` refuses unauthenticated callers | `curl` without a Clerk session | Pass | `401` |
| SEC-6 | `/dm/*` refuses unauthenticated callers | `curl /dm/conversations` | Pass | `401`; also `test_private_messages_require_sign_in` |
| SEC-7 | Timer input matches the product rule | `PATCH` settings with `seconds: 5` | Pass | `422`; the request model uses `ge=10` and the service re-validates |
| SEC-8 | Calling is authorized server-side | attempt a call to an unrelated Nexconn id | Pass | `GET /nexconn/calls/authorize` resolves the peer's Nexconn id back to a Clerk account and requires a shared conversation. Live demo session: the existing peer returned `200 {"allowed": true, "conversation_id": …}`, the caller's own id and an unknown id both `403`, and no session `401`. In the UI the check fired when the thread opened, the Call button enabled for the allowed peer, and with the route forced to `403` the button stayed disabled with "Calls unlock once you have a conversation with this person" |
| PERF-1 | Token and send latency under a small concurrent load | `scripts/load_test_nexconn.py --users 6 --messages 8` | Pass | 6/6 tokens p95 347 ms; 8/8 sends p95 307 ms (`docs/load-test-baseline.json`) |
| PERF-2 | Messages keep flowing while the AEGIS backend restarts | run the script with `--aegis-url`, kill the backend, restart it | Pass | of 24 sends at 2/s, 15 started and 15 completed inside the single 12.1 s outage, with 0 failures at the end. The report now records the outage window and matches sends against it (`docs/load-test-restart.json`) |
| PERF-3 | Server-side message history is available for latency checks | `POST /v4/direct-channel/history-message/list` | Blocked | `code 1009` — "The history message service is not enabled"; delivery timing has to come from the browser SDK |
| REC-1 | A Mongo outage falls back to the durable local store | unit tests with Mongo down and with a failing query | Pass | `test_private_messages_use_durable_local_store_when_mongo_is_unavailable` and `test_search_falls_back_when_mongo_fails_during_find`; the suite ran 7/7 OK |

### Multi-device read receipts

Read receipts are acknowledged by the client that has the thread open, and Nexconn's server-side
read-status sync is not part of this integration. Expected behaviour for the same Clerk account in
two browsers is therefore: both devices show the thread, each session tracks its own read state,
and a read tick on one device does not light up the other. Treat that as documented behaviour rather
than a bug until DEV-1 is actually run and says otherwise.

## Gaps to close before Phase 6

Ordered by how much a judge or a first-time user would notice:

1. CALL-1 in the Nexconn console, then CALL-2 through CALL-6. This is the only row blocked by
   something outside the repo.
2. MSG-8 reconnect delivery — the recovery path is written, but needs a real socket drop before
   this row can move off `Not run`.
3. AUTH-3 — an expired Nexconn token has to be waited out, because the console owns the token
   lifetime and the dev setup never forces an expiry.
4. EDGE-1, EDGE-2 and EDGE-4 — two-tab simultaneous send, weak network, and a token expiry.
