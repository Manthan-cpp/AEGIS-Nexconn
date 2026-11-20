"use client";

/**
 * Thin wrapper over the Nexconn Call SDK so a conversation can ring the other
 * participant. Chat still owns sign-in and the signalling connection, so this
 * module only installs the call engine on demand and reports state to the UI.
 *
 * Only audio is offered here. Calls are started from an open direct channel, so
 * a user can never cold-call someone found through username search.
 */

import type { NCCallEngine, NCCallEventHandler } from "@nexconn/call";

type CallSdk = typeof import("@nexconn/call");

export type CallStatus = "idle" | "outgoing" | "incoming" | "connected";

export type CallState = {
  status: CallStatus;
  callId: string | null;
  peerId: string | null;
  muted: boolean;
  error: string | null;
};

export type CallResult = { ok: true } | { ok: false; error: string };

let sdk: CallSdk | null = null;
let engine: NCCallEngine | null = null;

const listeners = new Set<(state: CallState) => void>();
let state: CallState = { status: "idle", callId: null, peerId: null, muted: false, error: null };

function emit(patch: Partial<CallState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

export function subscribeToCalls(listener: (state: CallState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

export function getCallState(): CallState {
  return state;
}

/** Turn a Nexconn call result code into something a person can act on. */
function startCallError(code: number): string {
  switch (code) {
    case 80002:
      return "You are already on a call. End it before starting another one.";
    case 80006:
      return "Calling is not enabled for this Nexconn app yet. Turn on audio and video calling in the Nexconn console and try again.";
    case 80007:
    case 80010:
      return "That contact cannot be reached by call.";
    case 80012:
      return "Aegis is not connected to Nexconn right now. Reconnect the messaging connection and try again.";
    default:
      return "Nexconn could not start that call.";
  }
}

async function ensureEngine(): Promise<{ ok: true; sdk: CallSdk; engine: NCCallEngine } | { ok: false; error: string }> {
  if (sdk && engine) return { ok: true, sdk, engine };

  try {
    const module = await import("@nexconn/call");
    module.NCCallEngine.install();
    const instance = module.NCCallEngine.initialize({});

    const handler: NCCallEventHandler = {
      onCallReceived(event) {
        // The caller id keeps the ringing banner attached to the conversation
        // the call actually belongs to, and the call id is what acceptCall
        // needs later.
        emit({
          status: "incoming",
          callId: event.session.getCallId(),
          peerId: event.session.getCallerUserId() || null,
          muted: false,
          error: null,
        });
      },
      onCallConnected() {
        emit({ status: "connected" });
      },
      onCallEnded() {
        emit({ status: "idle", callId: null, peerId: null, muted: false });
      },
    };
    instance.setCallEventHandler(handler);

    sdk = module;
    engine = instance;
    return { ok: true, sdk: module, engine: instance };
  } catch {
    return { ok: false, error: "Calling is not available in this browser right now." };
  }
}

/** Ask for the microphone before the SDK opens its own stream. */
async function requestMicrophone(): Promise<CallResult> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: "This browser cannot access a microphone." };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return { ok: true };
  } catch {
    return { ok: false, error: "Microphone access is needed to call. Allow it in the browser and try again." };
  }
}

export async function startAudioCall(
  peerId: string,
): Promise<{ ok: true; callId: string } | { ok: false; error: string }> {
  if (!peerId) return { ok: false, error: "This contact cannot receive calls yet." };

  const ready = await ensureEngine();
  if (!ready.ok) return ready;

  const microphone = await requestMicrophone();
  if (!microphone.ok) return microphone;

  try {
    const result = await ready.engine.startCall({
      calleeIds: [peerId],
      callType: ready.sdk.NCCallType.SINGLE,
      mediaType: ready.sdk.NCCallMediaType.AUDIO,
    });
    if (result.code !== 0 || !result.callId) {
      return { ok: false, error: startCallError(result.code) };
    }
    emit({ status: "outgoing", callId: result.callId, peerId, muted: false, error: null });
    return { ok: true, callId: result.callId };
  } catch {
    return { ok: false, error: "Nexconn could not start that call." };
  }
}

export async function acceptIncomingCall(): Promise<CallResult> {
  const ready = await ensureEngine();
  if (!ready.ok) return ready;
  const callId = state.callId;
  if (!callId) return { ok: false, error: "There is no incoming call to answer." };

  const microphone = await requestMicrophone();
  if (!microphone.ok) return microphone;

  try {
    const result = await ready.engine.acceptCall({ callId });
    if (result.code !== 0) return { ok: false, error: "Nexconn could not answer that call." };
    emit({ status: "connected" });
    return { ok: true };
  } catch {
    return { ok: false, error: "Nexconn could not answer that call." };
  }
}

export async function endActiveCall(): Promise<void> {
  const callId = state.callId ?? undefined;
  emit({ status: "idle", callId: null, peerId: null, muted: false });
  if (!engine) return;
  try {
    await engine.endCall(callId ? { callId } : undefined);
  } catch {
    // The local state is already reset; a failed hang-up must not trap the UI.
  }
}

export async function setCallMuted(muted: boolean): Promise<void> {
  emit({ muted });
  if (!engine) return;
  try {
    await engine.enableMicrophone(!muted);
  } catch {
    emit({ muted: !muted });
  }
}
