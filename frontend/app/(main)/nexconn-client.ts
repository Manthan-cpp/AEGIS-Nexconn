/**
 * Typed wrapper around the Nexconn Web Chat SDK.
 *
 * This is the only frontend module that imports `@nexconn/chat`. Flows talk to
 * these helpers instead of the raw SDK, so Phase 3 can rewire the Messages tool
 * without touching SDK details in component code.
 *
 * The App Key is fetched with the token response (and can be overridden with
 * NEXT_PUBLIC_NEXCONN_APP_KEY). The App Secret never reaches the browser.
 */

import type { AreaCode, DirectChannel } from "@nexconn/chat";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8123";
const HANDLER_ID = "aegis-direct-messages";

type Sdk = typeof import("@nexconn/chat");
type IncomingMessage = {
  messageId: string;
  channelIdentifier: { channelId: string; channelType: number };
  senderUserId: string;
  content?: unknown;
  sentTime: number;
  direction: number;
};

export type NexconnResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

export type SessionTokenProvider = (options?: { skipCache?: boolean }) => Promise<string | null>;

export type NexconnChatMessage = {
  id: string;
  channelId: string;
  senderId: string;
  text: string;
  sentAt: number;
  direction: "sent" | "received";
};

type TokenPayload = {
  token: string;
  user_id: string;
  app_key?: string;
  expires_at?: string | null;
};

let sdk: Sdk | null = null;
let sdkPromise: Promise<Sdk> | null = null;
let initialized = false;
let currentUserId: string | null = null;
let connectPromise: Promise<NexconnResult<{ userId: string }>> | null = null;
let sessionTokenProvider: SessionTokenProvider | null = null;
let messageHandlerRegistered = false;

const listeners = new Map<string, Set<(message: NexconnChatMessage) => void>>();

export function setSessionTokenProvider(provider: SessionTokenProvider | null): void {
  sessionTokenProvider = provider;
}

async function loadSdk(): Promise<Sdk> {
  if (sdk) return sdk;
  sdkPromise ??= import("@nexconn/chat").then((sdkModule) => {
    sdk = sdkModule;
    return sdkModule;
  });
  return sdkPromise;
}

function fail<T>(error: string, status?: number): NexconnResult<T> {
  return status === undefined ? { ok: false, error } : { ok: false, error, status };
}

function resolveAreaCode(sdkModule: Sdk): AreaCode {
  const configured = (process.env.NEXT_PUBLIC_NEXCONN_AREA_CODE ?? "SG").trim().toUpperCase();
  const areas = sdkModule.AreaCode as unknown as Record<string, number>;
  return (areas[configured] ?? sdkModule.AreaCode.SG) as AreaCode;
}

function toChatMessage(message: IncomingMessage): NexconnChatMessage {
  const content = (message.content ?? {}) as { text?: unknown };
  return {
    id: message.messageId,
    channelId: message.channelIdentifier.channelId,
    senderId: message.senderUserId,
    text: typeof content.text === "string" ? content.text : "",
    sentAt: message.sentTime,
    // MessageDirection.SEND === 1 in the SDK.
    direction: message.direction === 1 ? "sent" : "received",
  };
}

function registerMessageHandler(sdkModule: Sdk): void {
  if (messageHandlerRegistered) return;

  const handler = new sdkModule.MessageHandler({
    onMessageReceived({ messages }) {
      for (const message of messages) {
        if (message.channelIdentifier.channelType !== sdkModule.ChannelType.DIRECT) continue;
        const channelListeners = listeners.get(message.channelIdentifier.channelId);
        if (!channelListeners?.size) continue;
        const mapped = toChatMessage(message);
        for (const listener of channelListeners) listener(mapped);
      }
    },
  });

  sdkModule.NCEngine.addMessageHandler(HANDLER_ID, handler);
  messageHandlerRegistered = true;
}

async function ensureInitialized(sdkModule: Sdk, appKey: string): Promise<void> {
  if (initialized) return;
  sdkModule.NCEngine.initialize({ appKey, areaCode: resolveAreaCode(sdkModule) });
  registerMessageHandler(sdkModule);
  initialized = true;
}

async function requestTokenPayload(options: { forceRefresh?: boolean; skipCache?: boolean }): Promise<
  NexconnResult<TokenPayload>
> {
  if (!sessionTokenProvider) {
    return fail("Sign in to use private messages.");
  }

  let clerkToken = await sessionTokenProvider({ skipCache: options.skipCache });
  if (!clerkToken) return fail("Your sign-in session is not ready. Please sign in again.");

  const url = `${API_BASE_URL}/nexconn/token${options.forceRefresh ? "?refresh=1" : ""}`;
  const send = (token: string) =>
    fetch(url, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });

  let response: Response;
  try {
    response = await send(clerkToken);
  } catch {
    return fail(`Aegis cannot reach the backend at ${API_BASE_URL}. Start the backend on port 8123 and try again.`);
  }

  if (response.status === 401) {
    const freshToken = await sessionTokenProvider({ skipCache: true });
    if (freshToken && freshToken !== clerkToken) {
      clerkToken = freshToken;
      response = await send(clerkToken);
    }
  }

  const body = (await response.json().catch(() => null)) as (TokenPayload & { detail?: string }) | null;
  if (!response.ok || !body?.token) {
    const detail = typeof body?.detail === "string" ? body.detail : "Aegis could not start private messaging.";
    return fail(detail, response.status);
  }

  return { ok: true, data: body };
}

async function connectInternal(options: { forceRefresh?: boolean }): Promise<NexconnResult<{ userId: string }>> {
  if (currentUserId && !options.forceRefresh) {
    return { ok: true, data: { userId: currentUserId } };
  }

  const tokenResult = await requestTokenPayload({ forceRefresh: options.forceRefresh });
  if (!tokenResult.ok) return tokenResult;

  const appKey = tokenResult.data.app_key || process.env.NEXT_PUBLIC_NEXCONN_APP_KEY || "";
  if (!appKey) {
    return fail("Nexconn is not configured for this build.");
  }

  let sdkModule: Sdk;
  try {
    sdkModule = await loadSdk();
  } catch {
    return fail("The messaging library could not load. Refresh the page and try again.");
  }

  await ensureInitialized(sdkModule, appKey);

  const result = await sdkModule.NCEngine.connect({ token: tokenResult.data.token });
  if (result.code !== 0) {
    return fail(result.msg || "Nexconn could not open a messaging connection.", result.code);
  }

  currentUserId = result.data?.userId ?? tokenResult.data.user_id;
  return { ok: true, data: { userId: currentUserId } };
}

/** Connect once, reusing the in-flight attempt and the existing session. */
export async function connect(options: { forceRefresh?: boolean } = {}): Promise<NexconnResult<{ userId: string }>> {
  if (connectPromise) return connectPromise;
  connectPromise = connectInternal(options).finally(() => {
    connectPromise = null;
  });
  return connectPromise;
}

export async function disconnect(): Promise<void> {
  currentUserId = null;
  if (!sdk) return;
  await sdk.NCEngine.disconnect();
}

export function getCurrentUserId(): string | null {
  return currentUserId;
}

export async function getOrCreateDirectChannel(targetUserId: string): Promise<NexconnResult<DirectChannel>> {
  const target = targetUserId.trim();
  if (!target) return fail("Choose someone to message first.");

  try {
    const sdkModule = await loadSdk();
    return { ok: true, data: new sdkModule.DirectChannel(target) };
  } catch {
    return fail("The messaging library could not load. Refresh the page and try again.");
  }
}

export async function sendText(
  channel: DirectChannel,
  text: string,
): Promise<NexconnResult<NexconnChatMessage>> {
  const trimmed = text.trim();
  if (!trimmed) return fail("Write a message before sending it.");

  try {
    const sdkModule = await loadSdk();
    const result = await channel.sendMessage(new sdkModule.SendTextMessageParams({ text: trimmed }));
    if (result.code !== 0 || !result.data) {
      return fail(result.msg || "Nexconn could not send that message.", result.code);
    }
    return { ok: true, data: toChatMessage(result.data) };
  } catch {
    return fail("Aegis could not reach Nexconn to send that message.");
  }
}

/** Load the newest page of channel history (used as the polling fallback). */
export async function loadHistory(
  channel: DirectChannel,
  options: { pageSize?: number; before?: number } = {},
): Promise<NexconnResult<NexconnChatMessage[]>> {
  try {
    const sdkModule = await loadSdk();
    const query = sdkModule.BaseChannel.createMessagesQuery({
      channelIdentifier: channel.identifier,
      startTime: options.before ?? Date.now(),
      pageSize: Math.min(Math.max(options.pageSize ?? 30, 1), 100),
      isAscending: false,
    });
    const result = await query.loadNextPage();
    if (result.code !== 0 || !result.data) {
      return fail(result.msg || "Nexconn could not load this conversation.", result.code);
    }
    return { ok: true, data: result.data.data.map((message) => toChatMessage(message)) };
  } catch {
    return fail("Aegis could not reach Nexconn to load this conversation.");
  }
}

/** Subscribe to live messages for one direct channel. Returns an unsubscribe function. */
export function subscribeToChannel(
  channel: DirectChannel,
  listener: (message: NexconnChatMessage) => void,
): () => void {
  const channelId = channel.channelId;
  const channelListeners = listeners.get(channelId) ?? new Set();
  channelListeners.add(listener);
  listeners.set(channelId, channelListeners);

  return () => {
    const current = listeners.get(channelId);
    if (!current) return;
    current.delete(listener);
    if (!current.size) listeners.delete(channelId);
  };
}