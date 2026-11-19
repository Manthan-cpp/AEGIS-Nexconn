/**
 * Typed wrapper around the Nexconn Web Chat SDK.
 *
 * This is the only frontend module that imports `@nexconn/chat`. Flows talk to
 * these helpers instead of the raw SDK, so the Messages tool stays free of SDK
 * details.
 *
 * The App Key is fetched with the token response (and can be overridden with
 * NEXT_PUBLIC_NEXCONN_APP_KEY). The App Secret never reaches the browser.
 */

import type { AreaCode, ChannelIdentifier, DirectChannel, Message } from "@nexconn/chat";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8123";
const MESSAGE_HANDLER_ID = "aegis-direct-messages";
const CHANNEL_HANDLER_ID = "aegis-direct-channels";
const USER_HANDLER_ID = "aegis-direct-presence";
const TEXT_MESSAGE_TYPE = "RC:TxtMsg";
const TYPING_WINDOW_MS = 6_000;
const PRESENCE_SUBSCRIPTION_SECONDS = 3_600;
const PRESENCE_POLL_MS = 30_000;

// Matches the 12 MB upload ceiling the SOS and responder routers already use.
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const IMAGE_MESSAGE_TYPE = "RC:ImgMsg";
const FILE_MESSAGE_TYPE = "RC:FileMsg";
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);
const ALLOWED_FILE_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

type Sdk = typeof import("@nexconn/chat");
export type NexconnChannel = DirectChannel;

type RawMessage = {
  messageId: string;
  channelIdentifier: ChannelIdentifier;
  senderUserId: string;
  messageType?: string;
  content?: unknown;
  metadata?: Map<string, string> | Record<string, string> | null;
  sentTime: number;
  direction: number;
};

type TokenPayload = {
  token: string;
  user_id: string;
  app_key?: string;
  expires_at?: string | null;
};

type TypingListener = (channelId: string, isTyping: boolean) => void;
type ReceiptListener = (channelId: string, messageIds: string[]) => void;
type DeletionListener = (channelId: string, messageIds: string[]) => void;
type PresenceListener = (presence: Record<string, boolean>) => void;

export type NexconnResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

export type SessionTokenProvider = (options?: { skipCache?: boolean }) => Promise<string | null>;

export type NexconnAttachment = {
  kind: "image" | "file";
  url: string;
  name: string;
  size?: number;
  mime?: string;
  thumbnail?: string;
};

export type NexconnChatMessage = {
  id: string;
  channelId: string;
  senderId: string;
  text: string;
  attachment?: NexconnAttachment;
  sentAt: number;
  direction: "sent" | "received";
  isFromMe: boolean;
  metadata: Record<string, string>;
};

export type SendOptions = {
  needReceipt?: boolean;
  metadata?: Record<string, string>;
};

let sdk: Sdk | null = null;
let sdkPromise: Promise<Sdk> | null = null;
let initialized = false;
let currentUserId: string | null = null;
let connectPromise: Promise<NexconnResult<{ userId: string }>> | null = null;
let sessionTokenProvider: SessionTokenProvider | null = null;

const handlersRegistered = new Set<string>();
const listeners = new Map<string, Set<(message: NexconnChatMessage) => void>>();
const receiptListeners = new Set<ReceiptListener>();
const deletionListeners = new Set<DeletionListener>();
const typingListeners = new Set<TypingListener>();
const presenceListeners = new Set<PresenceListener>();
const subscribedPresenceUsers = new Set<string>();
const rawMessages = new Map<string, RawMessage>();
const typingTimers = new Map<string, number>();
const typingDeadlines = new Map<string, number>();

let presenceRefreshTimer: number | null = null;
let presencePollTimer: number | null = null;

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

function metadataOf(message: RawMessage): Record<string, string> {
  const source = message.metadata;
  if (!source) return {};
  if (source instanceof Map) {
    const entries: Record<string, string> = {};
    source.forEach((value, key) => {
      if (typeof value === "string") entries[key] = value;
    });
    return entries;
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") entries[key] = value;
  }
  return entries;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sizeOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Map an image/file payload to the shape the messages UI renders. */
function attachmentOf(
  messageType: string | undefined,
  content: Record<string, unknown>,
): NexconnAttachment | undefined {
  const url = stringOf(content.remoteUrl);
  if (!url) return undefined;

  if (messageType === IMAGE_MESSAGE_TYPE) {
    const thumbnail = stringOf(content.thumbnailBase64);
    return {
      kind: "image",
      url,
      name: stringOf(content.name) || "Image",
      size: sizeOf(content.size),
      mime: stringOf(content.fileType) || stringOf(content.type) || undefined,
      // Nexconn documents the thumbnail as a bare JPG base64 string.
      thumbnail: thumbnail ? `data:image/jpeg;base64,${thumbnail}` : undefined,
    };
  }

  if (messageType === FILE_MESSAGE_TYPE) {
    return {
      kind: "file",
      url,
      name: stringOf(content.name) || "Attachment",
      size: sizeOf(content.size),
      mime: stringOf(content.fileType) || undefined,
    };
  }

  return undefined;
}

function toChatMessage(message: RawMessage, fallbackType?: string): NexconnChatMessage {
  const content = (message.content ?? {}) as Record<string, unknown>;
  const channelId = message.channelIdentifier?.channelId ?? "";
  const senderId = message.senderUserId ?? "";
  return {
    id: message.messageId,
    channelId,
    senderId,
    text: stringOf(content.text),
    attachment: attachmentOf(message.messageType ?? fallbackType, content),
    sentAt: message.sentTime,
    direction: senderId && senderId === currentUserId ? "sent" : "received",
    isFromMe: Boolean(senderId) && senderId === currentUserId,
    metadata: metadataOf(message),
  };
}

function remember(message: RawMessage): void {
  if (!message?.messageId) return;
  rawMessages.set(message.messageId, message);
  if (rawMessages.size > 400) {
    const oldest = rawMessages.keys().next();
    if (!oldest.done) rawMessages.delete(oldest.value);
  }
}

function registerMessageHandler(sdkModule: Sdk): void {
  if (handlersRegistered.has(MESSAGE_HANDLER_ID)) return;

  const handler = new sdkModule.MessageHandler({
    onMessageReceived({ messages }) {
      for (const message of messages) {
        if (message.channelIdentifier?.channelType !== sdkModule.ChannelType.DIRECT) continue;
        remember(message as unknown as RawMessage);
        const channelListeners = listeners.get(message.channelIdentifier.channelId);
        if (!channelListeners?.size) continue;
        const mapped = toChatMessage(message as unknown as RawMessage);
        if (!mapped.text && !mapped.attachment) continue;
        for (const listener of channelListeners) listener(mapped);
      }
    },
    onMessageReceiptResponse({ responses }) {
      if (!receiptListeners.size) return;
      for (const response of responses) {
        const channelId = response.channelIdentifier?.channelId ?? "";
        if (!channelId || !response.messageId || response.readCount <= 0) continue;
        for (const listener of receiptListeners) listener(channelId, [response.messageId]);
      }
    },
    onMessageDeleted({ messages }) {
      if (!deletionListeners.size) return;
      const byChannel = new Map<string, string[]>();
      for (const message of messages) {
        const channelId = message.channelIdentifier?.channelId ?? "";
        if (!channelId || !message.messageId) continue;
        rawMessages.delete(message.messageId);
        const existing = byChannel.get(channelId) ?? [];
        existing.push(message.messageId);
        byChannel.set(channelId, existing);
      }
      for (const [channelId, ids] of byChannel) {
        for (const listener of deletionListeners) listener(channelId, ids);
      }
    },
  });

  sdkModule.NCEngine.addMessageHandler(MESSAGE_HANDLER_ID, handler);
  handlersRegistered.add(MESSAGE_HANDLER_ID);
}

function stopTyping(channelId: string): void {
  const timer = typingTimers.get(channelId);
  if (timer !== undefined) {
    window.clearInterval(timer);
    typingTimers.delete(channelId);
  }
  typingDeadlines.delete(channelId);
  for (const listener of typingListeners) listener(channelId, false);
}

function registerChannelHandler(sdkModule: Sdk): void {
  if (handlersRegistered.has(CHANNEL_HANDLER_ID)) return;

  const handler = new sdkModule.ChannelHandler({
    onTypingStatusChanged(event) {
      const channelId = event?.channelIdentifier?.channelId ?? "";
      if (!channelId || !typingListeners.size) return;
      const raw = event.userTypingStatus as unknown;
      const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const isRemoteTyping = entries.some((entry) => {
        const item = entry as { userId?: string; typingMessageType?: string };
        return Boolean(item?.typingMessageType) && item?.userId !== currentUserId;
      });
      if (!isRemoteTyping) {
        stopTyping(channelId);
        return;
      }

      typingDeadlines.set(channelId, Date.now() + TYPING_WINDOW_MS);
      for (const listener of typingListeners) listener(channelId, true);
      if (typingTimers.has(channelId)) return;
      const timer = window.setInterval(() => {
        const deadline = typingDeadlines.get(channelId) ?? 0;
        if (Date.now() >= deadline) stopTyping(channelId);
      }, 1_000);
      typingTimers.set(channelId, timer);
    },
  });

  sdkModule.NCEngine.addChannelHandler(CHANNEL_HANDLER_ID, handler);
  handlersRegistered.add(CHANNEL_HANDLER_ID);
}

async function refreshPresence(): Promise<void> {
  if (!sdk || subscribedPresenceUsers.size === 0 || !presenceListeners.size) return;
  try {
    const result = await sdk.NCEngine.userModule.getSubscribeUsersOnlineStatus([...subscribedPresenceUsers]);
    if (result.code !== 0) return;
    const snapshot: Record<string, boolean> = {};
    for (const item of result.data ?? []) snapshot[item.userId] = Boolean(item.isOnline);
    for (const listener of presenceListeners) listener(snapshot);
  } catch {
    // Presence is decoration; never surface a banner for it.
  }
}

function schedulePresenceRefresh(): void {
  if (presenceRefreshTimer !== null) return;
  presenceRefreshTimer = window.setTimeout(() => {
    presenceRefreshTimer = null;
    void refreshPresence();
  }, 400);
}

// Nexconn answers the first snapshot from cached state, so a peer that was
// already online can look offline until the next status event. A slow poll keeps
// the dots honest without hammering the service.
function startPresencePolling(): void {
  if (presencePollTimer !== null) return;
  presencePollTimer = window.setInterval(() => {
    if (!presenceListeners.size) {
      stopPresencePolling();
      return;
    }
    void refreshPresence();
  }, PRESENCE_POLL_MS);
}

function stopPresencePolling(): void {
  if (presencePollTimer === null) return;
  window.clearInterval(presencePollTimer);
  presencePollTimer = null;
}

function registerUserHandler(sdkModule: Sdk): void {
  if (handlersRegistered.has(USER_HANDLER_ID)) return;

  const handler = new sdkModule.UserHandler({
    onSubscriptionChanged() {
      schedulePresenceRefresh();
    },
  });

  sdkModule.NCEngine.addUserHandler(USER_HANDLER_ID, handler);
  handlersRegistered.add(USER_HANDLER_ID);
}

async function ensureInitialized(sdkModule: Sdk, appKey: string): Promise<void> {
  if (initialized) return;
  sdkModule.NCEngine.initialize({ appKey, areaCode: resolveAreaCode(sdkModule) });
  registerMessageHandler(sdkModule);
  registerChannelHandler(sdkModule);
  registerUserHandler(sdkModule);
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

  // A Clerk account switch reuses this module, so reconnect as the user the
  // fresh token belongs to instead of keeping the previous session.
  const nextUserId = tokenResult.data.user_id;
  if (currentUserId && nextUserId && currentUserId !== nextUserId) {
    currentUserId = null;
    try {
      await sdkModule.NCEngine.disconnect();
    } catch {
      // A failed cleanup should not block the new sign-in.
    }
  }

  const result = await sdkModule.NCEngine.connect({ token: tokenResult.data.token });
  if (result.code !== 0) {
    currentUserId = null;
    return fail(result.msg || "Nexconn could not open a messaging connection.", result.code);
  }

  currentUserId = result.data?.userId ?? nextUserId;
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
  listeners.clear();
  rawMessages.clear();
  if (!sdk) return;
  await sdk.NCEngine.disconnect();
}

export function getCurrentUserId(): string | null {
  return currentUserId;
}

export async function getOrCreateDirectChannel(targetUserId: string): Promise<NexconnResult<NexconnChannel>> {
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
  channel: NexconnChannel,
  text: string,
  options: SendOptions = {},
): Promise<NexconnResult<NexconnChatMessage>> {
  const trimmed = text.trim();
  if (!trimmed) return fail("Write a message before sending it.");
  if (trimmed.length > 2_000) return fail("Keep each message under 2,000 characters.");

  try {
    const sdkModule = await loadSdk();
    const params = new sdkModule.SendTextMessageParams({ text: trimmed });
    if (options.needReceipt) params.needReceipt = true;
    if (options.metadata) params.metadata = { ...options.metadata };
    const result = await channel.sendMessage(params);
    if (result.code !== 0 || !result.data) {
      return fail(result.msg || "Nexconn could not send that message.", result.code);
    }
    const raw = result.data as unknown as RawMessage;
    remember(raw);
    return { ok: true, data: toChatMessage(raw) };
  } catch {
    return fail("Aegis could not reach Nexconn to send that message.");
  }
}

async function sendMediaUpload(
  channel: NexconnChannel,
  file: File,
  kind: "image" | "file",
  options: SendOptions = {},
): Promise<NexconnResult<NexconnChatMessage>> {
  if (!file || file.size <= 0) return fail("Choose a non-empty image or file first.");
  if (file.size > MAX_ATTACHMENT_BYTES) return fail("Attachments must be 12 MB or smaller.");

  const mime = (file.type || "").toLowerCase();
  const allowed = kind === "image" ? ALLOWED_IMAGE_TYPES : ALLOWED_FILE_TYPES;
  if (!allowed.has(mime)) {
    return fail(
      kind === "image"
        ? "Send a JPEG, PNG, WebP, GIF or HEIC image."
        : "Send a PDF, text, CSV or Word document.",
    );
  }

  try {
    const sdkModule = await loadSdk();

    const finish = (
      result: { code: number; msg: string; data?: unknown },
      fallbackType: string,
    ): NexconnResult<NexconnChatMessage> => {
      if (result.code !== 0 || !result.data) {
        return fail(result.msg || "Nexconn could not send that attachment.", result.code);
      }
      const raw = result.data as RawMessage;
      remember(raw);
      // The send result is not guaranteed to echo messageType, so fall back to
      // the type we just uploaded.
      return { ok: true, data: toChatMessage(raw, fallbackType) };
    };

    if (kind === "image") {
      const prepared = await sdkModule.Helper.createSendImageMessageParams(file);
      if (prepared.code !== 0 || !prepared.data) {
        return fail(prepared.msg || "Aegis could not prepare that image.", prepared.code);
      }
      const params = prepared.data;
      if (options.needReceipt) params.needReceipt = true;
      if (options.metadata) params.metadata = { ...options.metadata };
      return finish(await channel.sendMediaMessage(params), IMAGE_MESSAGE_TYPE);
    }

    const prepared = await sdkModule.Helper.createSendFileMessageParams(file);
    if (prepared.code !== 0 || !prepared.data) {
      return fail(prepared.msg || "Aegis could not prepare that file.", prepared.code);
    }
    const params = prepared.data;
    if (options.needReceipt) params.needReceipt = true;
    if (options.metadata) params.metadata = { ...options.metadata };
    return finish(await channel.sendMediaMessage(params), FILE_MESSAGE_TYPE);
  } catch {
    return fail("Aegis could not upload that attachment. Check the connection and try again.");
  }
}

/** Upload and send an image (thumbnail is generated by the SDK helper). */
export async function sendImage(
  channel: NexconnChannel,
  file: File,
  options: SendOptions = {},
): Promise<NexconnResult<NexconnChatMessage>> {
  return sendMediaUpload(channel, file, "image", options);
}

/** Upload and send a document as a file message. */
export async function sendFile(
  channel: NexconnChannel,
  file: File,
  options: SendOptions = {},
): Promise<NexconnResult<NexconnChatMessage>> {
  return sendMediaUpload(channel, file, "file", options);
}

async function loadPage(channel: NexconnChannel, limit: number): Promise<NexconnResult<NexconnChatMessage[]>> {
  try {
    const sdkModule = await loadSdk();
    const query = sdkModule.BaseChannel.createMessagesQuery({
      channelIdentifier: channel.identifier,
      isAscending: false,
      pageSize: Math.min(Math.max(limit, 1), 100),
    });
    const page = await query.loadNextPage();
    if (page.code !== 0) {
      return fail(page.msg || "Aegis could not load this conversation.", page.code);
    }
    const rows = (page.data?.data ?? []) as unknown as RawMessage[];
    const messages = rows.map((row) => {
      remember(row);
      return toChatMessage(row);
    });
    return { ok: true, data: messages.filter((message) => message.text || message.attachment).reverse() };
  } catch {
    return fail("Aegis could not load this conversation from Nexconn.");
  }
}

/** Newest page of channel history, oldest-first for rendering. */
export async function fetchRecentMessages(
  channel: NexconnChannel,
  limit = 80,
): Promise<NexconnResult<NexconnChatMessage[]>> {
  return loadPage(channel, limit);
}

/** Single newest message, used for conversation-list previews. */
export async function fetchLatestMessage(channel: NexconnChannel): Promise<NexconnResult<NexconnChatMessage | null>> {
  // A small page keeps this correct whichever order the SDK returns.
  const page = await loadPage(channel, 5);
  if (!page.ok) return page;
  const newest = page.data.reduce<NexconnChatMessage | null>(
    (current, message) => (!current || message.sentAt > current.sentAt ? message : current),
    null,
  );
  return { ok: true, data: newest };
}

export function subscribe(channelId: string, listener: (message: NexconnChatMessage) => void): () => void {
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

export function subscribeToTyping(listener: TypingListener): () => void {
  typingListeners.add(listener);
  return () => {
    typingListeners.delete(listener);
    if (!typingListeners.size) {
      for (const channelId of [...typingTimers.keys()]) stopTyping(channelId);
    }
  };
}

export function subscribeToReceipts(listener: ReceiptListener): () => void {
  receiptListeners.add(listener);
  return () => {
    receiptListeners.delete(listener);
  };
}

/** Notifies when messages are recalled in a channel so the UI can drop them. */
export function subscribeToDeletions(listener: DeletionListener): () => void {
  deletionListeners.add(listener);
  return () => {
    deletionListeners.delete(listener);
  };
}

/** Every channel ID the SDK may use for this channel, for listener routing. */
export function channelIdsOf(channel: NexconnChannel): string[] {
  return [...new Set([channel.channelId, channel.identifier?.channelId ?? ""].filter(Boolean))];
}

export async function subscribeToPresence(
  userIds: string[],
  listener: PresenceListener,
): Promise<() => void> {
  let sdkModule: Sdk;
  try {
    sdkModule = await loadSdk();
  } catch {
    return () => {};
  }

  const ids = [...new Set(userIds.map((value) => value.trim()).filter(Boolean))].slice(0, 50);
  if (!ids.length || !initialized) return () => {};

  presenceListeners.add(listener);
  for (const id of ids) subscribedPresenceUsers.add(id);

  try {
    await sdkModule.NCEngine.userModule.subscribeEvent({
      subscribeType: sdkModule.SubscribeType.ONLINE_STATUS,
      userIds: ids,
      expiry: PRESENCE_SUBSCRIPTION_SECONDS,
    });
  } catch {
    // Without a live subscription, the one-time snapshot below still helps.
  }
  await refreshPresence();
  startPresencePolling();
  const firstSync = window.setTimeout(() => void refreshPresence(), 1_500);

  return () => {
    presenceListeners.delete(listener);
    for (const id of ids) subscribedPresenceUsers.delete(id);
    window.clearTimeout(firstSync);
    if (!presenceListeners.size) stopPresencePolling();
  };
}

/** Tell the other participant that this user is composing. */
export async function sendTyping(channel: NexconnChannel): Promise<void> {
  try {
    await channel.sendTypingStatus(TEXT_MESSAGE_TYPE);
  } catch {
    // Typing is best-effort and rate limited by Nexconn.
  }
}

/** Acknowledge received messages so the sender sees a read receipt. */
export async function markMessagesRead(channel: NexconnChannel, messageIds: string[]): Promise<void> {
  const ids = [...new Set(messageIds.filter(Boolean))].slice(0, 50);
  if (!ids.length) return;
  try {
    await channel.sendReadReceiptResponse(ids);
  } catch {
    // Receipts are best-effort.
  }
}

/**
 * Delete selected messages. A user's own messages are recalled for everyone,
 * while the other participant's messages are removed for this user only.
 */
export async function deleteMessages(
  channel: NexconnChannel,
  messageIds: string[],
): Promise<NexconnResult<string[]>> {
  const raw = messageIds.map((id) => rawMessages.get(id)).filter((value): value is RawMessage => Boolean(value));
  if (!raw.length) return fail("Those messages are no longer available.");

  const mine = raw.filter((message) => message.senderUserId === currentUserId);
  const theirs = raw.filter((message) => message.senderUserId !== currentUserId);

  try {
    for (const message of mine) {
      await channel.deleteMessageForAll(message as unknown as Message);
    }
    if (theirs.length) {
      await channel.deleteMessagesForMe(theirs as unknown as Message[]);
    }
  } catch {
    return fail("Aegis could not delete those messages from Nexconn.");
  }

  for (const message of raw) rawMessages.delete(message.messageId);
  return { ok: true, data: raw.map((message) => message.messageId) };
}
