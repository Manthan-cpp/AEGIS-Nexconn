# Nexconn functional test matrix

Scope: only the features that actually shipped. Phase 4.2 (chat-to-call) is blocked by
Nexconn `errCode 80006` because audio/video calling is not enabled for the app yet, so its
rows are listed but marked `Blocked` rather than skipped. Group channels were not built, so
group features are out of scope.

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
| AUTH-3 | Expired Clerk token mid-session recovers | let the tab idle past token life, send a message | Not run | request wrapper retries once with `getToken({skipCache:true})`; not exercised |
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
| MSG-7 | Duplicate-send guard | double-click Send with a slow network | Not run | composer sets `isSending` and disables the button; not exercised |
| MSG-8 | Offline → reconnect delivery | go offline mid-thread, send from the other tab, come back | Not run | this browser tooling has no network-offline control, so the socket drop could not be forced. Closing the thread and reloading did refetch history and show older messages, which covers the returning-client case only |
| MSG-9 | Disappearing message actually deletes from Nexconn | set a 10s timer, send, wait, check both tabs and history | Pass | with the 10s timer saved, the message was in the thread right after sending, gone after 14s, and still absent after a full page reload and a fresh history fetch — so the sender-side recall reached Nexconn instead of only hiding the bubble locally |
| MSG-10 | Long conversation history (100+ messages) | scroll a long thread | Not run | `fetchRecentMessages(channel, 80)` caps the window; pagination not built |
| MSG-11 | Enter sends, IME composition Enter does not | Japanese/Chinese IME in the composer | Pass | composing Enter and `keyCode 229` kept the draft; a normal Enter sent it |

## Bot in chat (Task 4.1)

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| BOT-1 | `/companion <text>` replies in the thread | type `/companion I feel anxious` in an open conversation | Pass | Phase 4.1: `Aegis Companion: …` appeared in both tabs with the bot label |
| BOT-2 | Bot reply is labelled, not attributed to the human peer | inspect the bubble meta | Pass | Phase 4.1: `is-bot` styling and the "Aegis Companion" label |
| BOT-3 | Safety-path parity with the standalone companion | send urgent-language text through `/companion` and compare with `companion-flow.tsx` | Fail | same text in the standalone companion rendered an "Immediate support" card with the backend's `urgent_support_message` plus Call 112 / Women's helpline 181 links. In the DM the reply arrived and was safety-first, but `replyAsCompanion` forwards only `reply`, so no urgent card and no helpline links appeared |

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
| CALL-1 | 1:1 audio call connects between two users with an open channel | two browsers, click Call | Blocked | `[NCCall][ERROR] callplus_client_start_call … errCode: 80006`; enable audio/video calling in the Nexconn console |
| CALL-2 | Microphone denial shows a clear message | block the mic permission, click Call | Not run | pre-flight `getUserMedia` maps denial to an explicit message |
| CALL-3 | Answer / Mute / End work | accept on the second tab, toggle mute, hang up | Not run | depends on CALL-1 |
| CALL-4 | Mid-call drop resets the UI | kill the network mid-call | Not run | depends on CALL-1 |
| CALL-5 | Call banner stays in its own conversation | start a call, open a different conversation | Not run | banner is matched on the caller/callee Nexconn id and a compact strip keeps Mute/End reachable elsewhere; needs CALL-1 to observe |
| CALL-6 | Incoming call opens its own thread | ring from the other tab while a different thread is open | Not run | depends on CALL-1 |

## Multi-device

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| DEV-1 | Same Clerk account, two browsers | sign in as one account in both, message from the other account | Not run | Nexconn's server read-status sync is N/A per the Phase 3 research, so read ticks are expected to be per-session — record what actually happens before claiming either way |
| DEV-2 | Conversation metadata stays consistent across devices | open the same thread in both | Not run | |

## Transport and security basics

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| SEC-1 | Foreign origin is rejected on preflight | `curl -X OPTIONS /nexconn/token -H "Origin: https://evil.example"` | Pass | `400` |
| SEC-2 | The app origin is allowed | same request with `Origin: http://localhost:3000` | Pass | `200` |
| SEC-3 | Nexconn App Key/secret never reaches the browser bundle | production build, grep the built JS for the key | Not run | needs `npm run build`, planned under Task 5.3 |
| SEC-4 | `/nexconn/token` rate limit fires | burst requests with a valid token | Not run | limiter exists (`_rate_limit_per_minute`); not exercised |

## Backend regression

| ID | Check | How | Status | Evidence |
|---|---|---|---|---|
| REG-1 | Backend test suite stays green | `cd backend && ./.venv/Scripts/python.exe -m pytest` | Pass | 122 tests ran green during Phase 3.6 / CORS work; not re-run while writing this matrix |

## Gaps to close before Phase 6

Ordered by how much a judge or a first-time user would notice:

1. CALL-1 in the Nexconn console, then CALL-2 through CALL-6.
2. BOT-3 safety parity — render the `urgent_support_message` card and helpline links inside the
   DM thread. The response already carries them, so the bot reply only needs to keep them.
3. MSG-8 reconnect delivery — needs a way to drop the socket mid-session before this row can
   move off `Not run`.
4. DEV-1 — decide what to document as expected multi-device behaviour.
