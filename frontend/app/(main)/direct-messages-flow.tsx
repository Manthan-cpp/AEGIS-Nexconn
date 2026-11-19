"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, CheckCheck, Clock, MessageSquare, RefreshCw, Search, Send, Trash2 } from "lucide-react";
import { SignInButton, SignUpButton, useAuth, useUser } from "@clerk/nextjs";
import {
  type NexconnChannel,
  type NexconnChatMessage,
  channelIdsOf,
  connect,
  deleteMessages,
  fetchLatestMessage,
  fetchRecentMessages,
  getOrCreateDirectChannel,
  markMessagesRead,
  sendText,
  sendTyping,
  setSessionTokenProvider,
  subscribe,
  subscribeToDeletions,
  subscribeToPresence,
  subscribeToReceipts,
  subscribeToTyping,
} from "./nexconn-client";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8123";
const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

// Nexconn pushes messages, so the history poll is a slow safety net rather than
// the delivery path it used to be.
const POLL_INTERVAL_MS = 8_000;
const EXPIRY_TICK_MS = 5_000;
const TYPING_THROTTLE_MS = 5_000;

type Profile = {
  user_id: string;
  username: string;
  display_name: string;
  nexconn_user_id?: string;
};

type Conversation = {
  conversation_id: string;
  recipient: Profile;
  last_message: string;
  last_sender_id: string;
  updated_at: string;
  is_last_message_from_me: boolean;
  disappearing_enabled: boolean;
  disappearing_seconds: number;
};

type ConversationSettings = {
  conversation_id: string;
  disappearing_enabled: boolean;
  disappearing_seconds: number;
};

type Preview = {
  text: string;
  sentAt: number;
  fromMe: boolean;
};

const DISAPPEARING_OPTIONS = [
  { value: 10, label: "10 seconds" },
  { value: 600, label: "10 minutes" },
  { value: 3_600, label: "1 hour" },
  { value: 21_600, label: "6 hours" },
  { value: 36_000, label: "10 hours" },
  { value: 86_400, label: "24 hours" },
];

function disappearingLabel(seconds: number) {
  return DISAPPEARING_OPTIONS.find((option) => option.value === seconds)?.label || `${seconds} seconds`;
}

type Message = {
  message_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  expires_at: string | null;
  is_from_me: boolean;
  read?: boolean;
};

function toUiMessage(message: NexconnChatMessage): Message {
  const expiry = message.metadata["aegis_expires_at"];
  const parsed = expiry ? Date.parse(expiry) : Number.NaN;
  return {
    message_id: message.id,
    sender_id: message.senderId,
    content: message.text,
    created_at: new Date(message.sentAt).toISOString(),
    expires_at: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
    is_from_me: message.isFromMe,
    read: false,
  };
}

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  if (!incoming.length) return current;
  const byId = new Map(current.map((message) => [message.message_id, message]));
  for (const message of incoming) {
    const existing = byId.get(message.message_id);
    byId.set(
      message.message_id,
      existing ? { ...existing, ...message, read: Boolean(existing.read || message.read) } : message,
    );
  }
  return [...byId.values()].sort((first, second) => Date.parse(first.created_at) - Date.parse(second.created_at));
}

function GuestMessagesFlow({ onBack }: { onBack: () => void }) {
  return (
    <section className="dm-flow" aria-labelledby="dm-title">
      <button className="back-link" type="button" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden="true" />
        <span>Back to toolkit</span>
      </button>
      <div className="dm-guest-card">
        <span className="dm-icon" aria-hidden="true"><MessageSquare size={36} /></span>
        <p className="eyebrow">Private conversations</p>
        <h2 id="dm-title">Sign in to message someone safely.</h2>
        <p>
          Direct messages are private to signed-in Aegis accounts. You can still use the SOS tools and chat companions as a guest.
        </p>
        {clerkConfigured ? (
          <div className="dm-auth-actions">
            <SignInButton mode="modal">
              <button className="dm-primary-button" type="button">Sign in</button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="dm-secondary-button" type="button">Create account</button>
            </SignUpButton>
          </div>
        ) : (
          <p className="dm-muted">Account setup is not configured yet.</p>
        )}
      </div>
    </section>
  );
}

export default function DirectMessagesFlow({ onBack }: { onBack: () => void }) {
  if (!clerkConfigured) return <GuestMessagesFlow onBack={onBack} />;
  return <AuthenticatedMessagesFlow onBack={onBack} />;
}

function AuthenticatedMessagesFlow({ onBack }: { onBack: () => void }) {
  const { getToken } = useAuth();
  const { isLoaded, isSignedIn, user } = useUser();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Profile[]>([]);
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsEnabled, setSettingsEnabled] = useState(false);
  const [settingsSeconds, setSettingsSeconds] = useState("21600");
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "ready" | "unavailable">("connecting");
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [typingChannelId, setTypingChannelId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});

  const channelRef = useRef<{ channel: NexconnChannel; peerId: string } | null>(null);
  const recalledRef = useRef<Set<string>>(new Set());
  const lastTypingSentRef = useRef(0);

  const displayName = useMemo(
    () => user?.fullName || user?.username || "Aegis user",
    [user],
  );
  const username = user?.username || user?.id.replace(/^user_/, "aegisuser");

  const request = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const method = (options.method || "GET").toUpperCase();
    const backendUnavailable = `Aegis cannot reach the backend at ${API_BASE_URL}. Start the backend on port 8123 and try again.`;
    const send = async (token: string) => fetch(`${API_BASE_URL}${path}`, {
      ...options,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });

    let token = await getToken();
    if (!token) throw new Error("Your sign-in session is not ready. Please sign in again.");

    let response: Response;
    try {
      response = await send(token);
    } catch {
      // GET requests are safe to retry after a short-lived server restart or
      // network hiccup. Do not blindly retry requests that may have written.
      if (method !== "GET") throw new Error(backendUnavailable);
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      try {
        response = await send(token);
      } catch {
        throw new Error(backendUnavailable);
      }
    }
    // Clerk normally refreshes tokens automatically. A long-open tab or an
    // account switch can leave one cached token stale, so recover once before
    // asking the user to sign in again.
    if (response.status === 401) {
      const freshToken = await getToken({ skipCache: true });
      if (freshToken) {
        token = freshToken;
        response = await send(token);
      }
    }

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(typeof body?.detail === "string" ? body.detail : "Aegis could not complete that request.");
    }
    return body as T;
  }, [getToken]);

  const loadConversations = useCallback(async () => {
    const loaded = await request<Conversation[]>("/dm/conversations");
    setConversations(loaded);
    setSelected((current) => {
      const next = !current
        ? (loaded[0] || null)
        : (loaded.find((item) => item.conversation_id === current.conversation_id) || current);
      if (next && (!current
        || next.conversation_id !== current.conversation_id
        || next.disappearing_enabled !== current.disappearing_enabled
        || next.disappearing_seconds !== current.disappearing_seconds)) {
        setSettingsEnabled(next.disappearing_enabled);
        setSettingsSeconds(String(next.disappearing_seconds || 21600));
      }
      return next;
    });
  }, [request]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user || !username) return;
    let active = true;
    const loadAccount = async () => {
      setIsLoading(true);
      setError("");
      try {
        await Promise.all([
          request<Profile>("/dm/profile", {
            method: "POST",
            body: JSON.stringify({ username, display_name: displayName }),
          }),
          loadConversations(),
        ]);
      } catch (requestError: unknown) {
        if (active) setError(requestError instanceof Error ? requestError.message : "Aegis could not load private messages.");
      } finally {
        if (active) setIsLoading(false);
      }
    };
    void loadAccount();
    return () => { active = false; };
  }, [displayName, isLoaded, isSignedIn, loadConversations, request, user, username]);

  const userId = user?.id ?? "";

  // Nexconn owns the transport, so the SDK connection is opened once per
  // signed-in account and reused for every conversation.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    let active = true;
    setSessionTokenProvider((options) => getToken(options));
    setConnection("connecting");
    void connect().then((result) => {
      if (!active) return;
      if (result.ok) {
        setConnection("ready");
        return;
      }
      setConnection("unavailable");
      setError(result.error);
    });
    return () => { active = false; };
  }, [getToken, isLoaded, isSignedIn, userId]);

  useEffect(() => {
    if (connection !== "ready") return;
    return subscribeToTyping((channelId, isTyping) => {
      setTypingChannelId((current) => (isTyping ? channelId : current === channelId ? null : current));
    });
  }, [connection]);

  useEffect(() => {
    if (connection !== "ready") return;
    return subscribeToDeletions((_channelId, messageIds) => {
      const removed = new Set(messageIds);
      setMessages((current) => {
        if (!current.some((message) => removed.has(message.message_id))) return current;
        return current.filter((message) => !removed.has(message.message_id));
      });
      setSelectedMessageIds((current) => current.filter((messageId) => !removed.has(messageId)));
    });
  }, [connection]);

  useEffect(() => {
    if (connection !== "ready") return;
    return subscribeToReceipts((_channelId, messageIds) => {
      const read = new Set(messageIds);
      setMessages((current) => {
        if (!current.some((message) => read.has(message.message_id) && !message.read)) return current;
        return current.map((message) => (read.has(message.message_id) ? { ...message, read: true } : message));
      });
    });
  }, [connection]);

  const activeConversationId = selected?.conversation_id ?? "";
  const activePeerId = selected?.recipient.nexconn_user_id ?? "";

  useEffect(() => {
    if (connection !== "ready" || !activeConversationId || !activePeerId) return;
    let active = true;
    let channel: NexconnChannel | null = null;
    let unsubscribeMessages: Array<() => void> = [];
    let pollTimer: number | null = null;
    const readConfirmed = new Set<string>();

    setMessages([]);
    setNotice("");
    setError("");

    const confirmRead = (incoming: NexconnChatMessage[]) => {
      if (!channel) return;
      const fresh = incoming.filter((message) => !message.isFromMe && !readConfirmed.has(message.id));
      if (!fresh.length) return;
      for (const message of fresh) readConfirmed.add(message.id);
      void markMessagesRead(channel, fresh.map((message) => message.id));
    };

    const start = async () => {
      const channelResult = await getOrCreateDirectChannel(activePeerId);
      if (!active) return;
      if (!channelResult.ok) {
        setError(channelResult.error);
        return;
      }
      channel = channelResult.data;
      channelRef.current = { channel, peerId: activePeerId };

      const handleMessage = (message: NexconnChatMessage) => {
        if (!active) return;
        setMessages((current) => mergeMessages(current, [toUiMessage(message)]));
        setPreviews((current) => ({
          ...current,
          [activeConversationId]: { text: message.text, sentAt: message.sentAt, fromMe: message.isFromMe },
        }));
        if (!message.isFromMe) {
          confirmRead([message]);
          setTypingChannelId(null);
        }
      };
      unsubscribeMessages = channelIdsOf(channel).map((channelId) => subscribe(channelId, handleMessage));

      const history = await fetchRecentMessages(channel, 80);
      if (!active) return;
      if (history.ok) {
        setMessages(history.data.map(toUiMessage));
        confirmRead(history.data);
        const latest = history.data[history.data.length - 1];
        if (latest) {
          setPreviews((current) => ({
            ...current,
            [activeConversationId]: { text: latest.text, sentAt: latest.sentAt, fromMe: latest.isFromMe },
          }));
        }
      } else {
        setError(history.error);
      }

      pollTimer = window.setInterval(async () => {
        if (!active || !channel || document.hidden) return;
        const latest = await fetchRecentMessages(channel, 80);
        if (!active || !latest.ok) return;
        setMessages((current) => mergeMessages(current, latest.data.map(toUiMessage)));
        confirmRead(latest.data);
      }, POLL_INTERVAL_MS);
    };

    void start();

    return () => {
      active = false;
      for (const unsubscribe of unsubscribeMessages) unsubscribe();
      if (pollTimer !== null) window.clearInterval(pollTimer);
      if (channelRef.current?.channel === channel) channelRef.current = null;
      setTypingChannelId(null);
    };
  }, [activeConversationId, activePeerId, connection]);

  const ensureChannel = useCallback(async (peerId: string) => {
    const current = channelRef.current;
    if (current?.peerId === peerId) return { ok: true as const, data: current.channel };
    const result = await getOrCreateDirectChannel(peerId);
    if (result.ok) channelRef.current = { channel: result.data, peerId };
    return result;
  }, []);

  useEffect(() => {
    if (connection !== "ready") return;
    const peerIds = conversations
      .map((conversation) => conversation.recipient.nexconn_user_id)
      .filter((value): value is string => Boolean(value));
    if (activePeerId && !peerIds.includes(activePeerId)) peerIds.push(activePeerId);
    if (!peerIds.length) return;

    let active = true;
    let unsubscribe: (() => void) | null = null;
    void subscribeToPresence(peerIds, (snapshot) => {
      if (!active) return;
      setPresence((current) => {
        const next = { ...current, ...snapshot };
        const changed = Object.keys(next).some((key) => next[key] !== current[key]);
        return changed ? next : current;
      });
    }).then((cleanup) => {
      if (active) unsubscribe = cleanup;
      else cleanup();
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [activePeerId, connection, conversations]);

  // Conversation previews now come from Nexconn history because AEGIS no
  // longer stores message content in its own database.
  useEffect(() => {
    if (connection !== "ready" || conversations.length === 0) return;
    let active = true;
    void Promise.all(
      conversations.slice(0, 20).map(async (conversation) => {
        const peerId = conversation.recipient.nexconn_user_id;
        if (!peerId) return;
        const channelResult = await getOrCreateDirectChannel(peerId);
        if (!channelResult.ok) return;
        const latest = await fetchLatestMessage(channelResult.data);
        if (!active || !latest.ok || !latest.data) return;
        const message = latest.data;
        setPreviews((current) => {
          const existing = current[conversation.conversation_id];
          if (existing && existing.sentAt >= message.sentAt) return current;
          return {
            ...current,
            [conversation.conversation_id]: { text: message.text, sentAt: message.sentAt, fromMe: message.isFromMe },
          };
        });
      }),
    );
    return () => { active = false; };
  }, [conversations, connection]);

  // Disappearing messages: Nexconn has no native TTL, so a message carries its
  // own expiry in metadata and the sender's client recalls it once it lapses.
  useEffect(() => {
    const cleanupTimer = window.setInterval(() => {
      const now = Date.now();
      setMessages((current) => {
        const expired = current.filter((message) => message.expires_at && Date.parse(message.expires_at) <= now);
        if (!expired.length) return current;
        const channel = channelRef.current?.channel;
        const recallable = expired
          .filter((message) => message.is_from_me && !recalledRef.current.has(message.message_id))
          .map((message) => message.message_id);
        if (channel && recallable.length) {
          for (const messageId of recallable) recalledRef.current.add(messageId);
          void deleteMessages(channel, recallable);
        }
        return current.filter((message) => !(message.expires_at && Date.parse(message.expires_at) <= now));
      });
    }, EXPIRY_TICK_MS);
    return () => window.clearInterval(cleanupTimer);
  }, []);

  const orderedConversations = useMemo(() => {
    const timestamp = (conversation: Conversation) =>
      previews[conversation.conversation_id]?.sentAt ?? (Date.parse(conversation.updated_at) || 0);
    return [...conversations].sort((first, second) => timestamp(second) - timestamp(first));
  }, [conversations, previews]);

  const typingChannelIds = channelRef.current ? channelIdsOf(channelRef.current.channel) : [];
  const isPeerTyping = Boolean(typingChannelId && typingChannelIds.includes(typingChannelId));

  if (!isLoaded) {
    return <section className="dm-flow"><p className="dm-muted">Loading account…</p></section>;
  }

  if (!isSignedIn || !user) {
    return <GuestMessagesFlow onBack={onBack} />;
  }

  async function searchUsers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      setResults(await request<Profile[]>(`/dm/users?query=${encodeURIComponent(search.trim())}`));
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Aegis could not search for that user.");
    }
  }

  async function openConversation(profile: Profile) {
    setError("");
    setNotice("");
    try {
      const conversation = await request<Conversation>("/dm/conversations", {
        method: "POST",
        body: JSON.stringify({ username: profile.username }),
      });
      setSelected(conversation);
      setSettingsEnabled(conversation.disappearing_enabled);
      setSettingsSeconds(String(conversation.disappearing_seconds || 21600));
      setIsSettingsOpen(false);
      setSelectionMode(false);
      setSelectedMessageIds([]);
      setResults([]);
      setSearch("");
      await loadConversations();
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Aegis could not start that conversation.");
    }
  }

  function selectConversation(conversation: Conversation) {
    setSelected(conversation);
    setSettingsEnabled(conversation.disappearing_enabled);
    setSettingsSeconds(String(conversation.disappearing_seconds || 21600));
    setIsSettingsOpen(false);
    setSelectionMode(false);
    setSelectedMessageIds([]);
  }

  function handleDraftChange(value: string) {
    setDraft(value);
    const active = channelRef.current;
    if (!active || !value.trim()) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return;
    lastTypingSentRef.current = now;
    void sendTyping(active.channel);
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !draft.trim() || isSending) return;
    const peerId = selected.recipient.nexconn_user_id;
    if (!peerId) {
      setError("This contact cannot receive Nexconn messages yet. Ask them to sign in once more.");
      return;
    }

    setIsSending(true);
    setError("");
    setNotice("");
    const content = draft.trim();
    try {
      const channelResult = await ensureChannel(peerId);
      if (!channelResult.ok) {
        setError(channelResult.error);
        return;
      }

      const metadata: Record<string, string> = { aegis_conversation_id: selected.conversation_id };
      if (selected.disappearing_enabled) {
        const seconds = Math.max(10, Number(selected.disappearing_seconds) || 21600);
        metadata.aegis_expires_at = new Date(Date.now() + seconds * 1000).toISOString();
      }

      const sent = await sendText(channelResult.data, content, { needReceipt: true, metadata });
      if (!sent.ok) {
        setError(sent.error);
        return;
      }

      setDraft("");
      setNotice("Message sent.");
      setMessages((current) => mergeMessages(current, [toUiMessage(sent.data)]));
      setPreviews((current) => ({
        ...current,
        [selected.conversation_id]: { text: sent.data.text, sentAt: sent.data.sentAt, fromMe: true },
      }));
    } finally {
      setIsSending(false);
    }
  }

  function toggleMessageSelection(messageId: string) {
    setSelectedMessageIds((current) => current.includes(messageId)
      ? current.filter((id) => id !== messageId)
      : [...current, messageId]);
  }

  async function saveConversationSettings() {
    if (!selected) return;
    const seconds = Number(settingsSeconds);
    if (!Number.isSafeInteger(seconds) || seconds < 10 || !DISAPPEARING_OPTIONS.some((option) => option.value === seconds)) {
      setError("Choose one of the available timers, starting at 10 seconds.");
      return;
    }
    setIsSavingSettings(true);
    setError("");
    try {
      const saved = await request<ConversationSettings>(`/dm/conversations/${selected.conversation_id}/settings`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: settingsEnabled, seconds }),
      });
      setSelected((current) => current?.conversation_id === saved.conversation_id
        ? { ...current, ...saved }
        : current);
      setConversations((current) => current.map((conversation) => conversation.conversation_id === saved.conversation_id
        ? { ...conversation, ...saved }
        : conversation));
      setSettingsSeconds(String(saved.disappearing_seconds));
      setSettingsEnabled(saved.disappearing_enabled);
      setIsSettingsOpen(false);
      setNotice(saved.disappearing_enabled
        ? `New messages will disappear after ${disappearingLabel(saved.disappearing_seconds)}.`
        : "Disappearing messages are turned off.");
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Aegis could not save that setting.");
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function deleteSelectedMessages() {
    if (!selected || selectedMessageIds.length === 0) return;
    const peerId = selected.recipient.nexconn_user_id;
    if (!peerId) {
      setError("This contact cannot receive Nexconn messages yet. Ask them to sign in once more.");
      return;
    }

    setIsDeleting(true);
    setError("");
    try {
      const channelResult = await ensureChannel(peerId);
      if (!channelResult.ok) {
        setError(channelResult.error);
        return;
      }
      const deleted = await deleteMessages(channelResult.data, selectedMessageIds);
      if (!deleted.ok) {
        setError(deleted.error);
        return;
      }
      const deletedIds = new Set(deleted.data);
      setMessages((current) => current.filter((message) => !deletedIds.has(message.message_id)));
      setSelectedMessageIds([]);
      setSelectionMode(false);
      setNotice(deleted.data.length === 1
        ? "Message deleted."
        : `${deleted.data.length} messages deleted.`);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <section className="dm-flow" aria-labelledby="dm-title">
      <div className="dm-heading-row">
        <button className="back-link" type="button" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          <span>Back to toolkit</span>
        </button>
        <span className="dm-account-chip">@{username}</span>
      </div>
      <div className="dm-header-copy">
        <p className="eyebrow">Private conversations</p>
        <h2 id="dm-title">A quiet line to someone you trust.</h2>
        <p>Search by username to start a private conversation. Messages are only available to the two signed-in accounts.</p>
      </div>

      <div className="dm-layout">
        <aside className="dm-sidebar" aria-label="Conversations and user search">
          <form className="dm-search-form" onSubmit={searchUsers}>
            <label htmlFor="dm-search">Find a username</label>
            <div className="dm-search-row">
              <input id="dm-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="e.g. isha" maxLength={64} />
              <button className="dm-small-button" type="submit">
                <Search size={13} aria-hidden="true" /> Search
              </button>
            </div>
          </form>
          {results.length > 0 && (
            <div className="dm-search-results">
              {results.map((profile) => (
                <button className="dm-profile-result" type="button" key={profile.user_id} onClick={() => void openConversation(profile)}>
                  <span className="dm-avatar-wrap">
                    <span className="dm-profile-avatar" aria-hidden="true">{profile.username.slice(0, 1).toUpperCase()}</span>
                    <span
                      className={`dm-presence ${profile.nexconn_user_id && presence[profile.nexconn_user_id] ? "is-online" : ""}`}
                      aria-hidden="true"
                    />
                  </span>
                  <span><strong>{profile.display_name}</strong><small>@{profile.username}</small></span>
                </button>
              ))}
            </div>
          )}
          <div className="dm-list-heading">
            <span>Your conversations</span>
            <button type="button" onClick={() => void loadConversations()} aria-label="Refresh conversations">
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          </div>
          {isLoading && <p className="dm-muted">Loading…</p>}
          {!isLoading && conversations.length === 0 && <p className="dm-muted">No private conversations yet.</p>}
          <div className="dm-conversation-list">
            {orderedConversations.map((conversation) => (
              <button
                className={`dm-conversation-item ${selected?.conversation_id === conversation.conversation_id ? "is-selected" : ""}`}
                type="button"
                key={conversation.conversation_id}
                aria-pressed={selected?.conversation_id === conversation.conversation_id}
                onClick={() => selectConversation(conversation)}
              >
                <span className="dm-avatar-wrap">
                  <span className="dm-profile-avatar" aria-hidden="true">{conversation.recipient.username.slice(0, 1).toUpperCase()}</span>
                  <span
                    className={`dm-presence ${conversation.recipient.nexconn_user_id && presence[conversation.recipient.nexconn_user_id] ? "is-online" : ""}`}
                    aria-hidden="true"
                  />
                </span>
                <span>
                  <strong>{conversation.recipient.display_name}</strong>
                  <small>@{conversation.recipient.username}</small>
                  <em>
                    {previews[conversation.conversation_id]
                      ? `${previews[conversation.conversation_id].fromMe ? "You: " : ""}${previews[conversation.conversation_id].text}`
                      : (conversation.last_message || "Conversation started")}
                  </em>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <div className="dm-conversation-panel">
          {selected ? (
            <>
              <div className="dm-conversation-heading">
                <span className="dm-avatar-wrap">
                  <span className="dm-profile-avatar" aria-hidden="true">{selected.recipient.username.slice(0, 1).toUpperCase()}</span>
                  <span
                    className={`dm-presence ${selected.recipient.nexconn_user_id && presence[selected.recipient.nexconn_user_id] ? "is-online" : ""}`}
                    aria-hidden="true"
                  />
                </span>
                <div>
                  <strong>{selected.recipient.display_name}</strong>
                  <small>
                    @{selected.recipient.username}
                    {selected.recipient.nexconn_user_id && presence[selected.recipient.nexconn_user_id] ? " · Online" : ""}
                  </small>
                </div>
                <div className="dm-conversation-tools">
                  <button className={`dm-tool-button ${selected.disappearing_enabled ? "is-active" : ""}`} type="button" onClick={() => setIsSettingsOpen((current) => !current)}>
                    <Clock size={12} aria-hidden="true" />
                    <span>{selected.disappearing_enabled ? `${disappearingLabel(selected.disappearing_seconds)} disappearing` : "Disappearing"}</span>
                  </button>
                  <button className={`dm-tool-button ${selectionMode ? "is-active" : ""}`} type="button" onClick={() => {
                    setSelectionMode((current) => !current);
                    setSelectedMessageIds([]);
                  }}>
                    {selectionMode ? "Cancel" : "Select"}
                  </button>
                </div>
              </div>
              {isSettingsOpen && (
                <div className="dm-settings-panel" role="region" aria-label="Disappearing message settings">
                  <label className="dm-settings-toggle">
                    <input type="checkbox" checked={settingsEnabled} onChange={(event) => setSettingsEnabled(event.target.checked)} />
                    <span><strong>Disappearing messages</strong><small>Only messages sent after saving this setting will expire.</small></span>
                  </label>
                  <div className="dm-settings-row">
                    <label htmlFor="dm-disappearing-duration">Delete new messages after</label>
                    <select
                      id="dm-disappearing-duration"
                      value={settingsSeconds}
                      onChange={(event) => setSettingsSeconds(event.target.value)}
                    >
                      {DISAPPEARING_OPTIONS.map((option) => (
                        <option value={option.value} key={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  <p className="dm-settings-help">Choose when new messages should disappear. The minimum timer is 10 seconds.</p>
                  <button className="dm-primary-button" type="button" onClick={() => void saveConversationSettings()} disabled={isSavingSettings}>
                    {isSavingSettings ? "Saving…" : "Save settings"}
                  </button>
                </div>
              )}
              {selectionMode && (
                <div className="dm-selection-toolbar" role="toolbar" aria-label="Selected messages">
                  <span>{selectedMessageIds.length} selected</span>
                  <button className="dm-delete-button" type="button" onClick={() => void deleteSelectedMessages()} disabled={isDeleting || selectedMessageIds.length === 0}>
                    <Trash2 size={12} aria-hidden="true" />
                    <span>{isDeleting ? "Deleting…" : "Delete selected"}</span>
                  </button>
                </div>
              )}
              <div className="dm-messages" aria-live="polite">
                {messages.length === 0 && (
                  <p className="dm-empty-conversation">
                    {connection === "ready" ? "This is the beginning of a private conversation." : "Connecting to secure messaging…"}
                  </p>
                )}
                {messages.map((message) => (
                  <div
                    className={`dm-message ${message.is_from_me ? "is-mine" : "is-theirs"} ${selectionMode ? "is-selectable" : ""} ${selectedMessageIds.includes(message.message_id) ? "is-selected" : ""}`}
                    key={message.message_id}
                    role={selectionMode ? "checkbox" : undefined}
                    aria-checked={selectionMode ? selectedMessageIds.includes(message.message_id) : undefined}
                    tabIndex={selectionMode ? 0 : undefined}
                    onClick={selectionMode ? () => toggleMessageSelection(message.message_id) : undefined}
                    onKeyDown={selectionMode ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleMessageSelection(message.message_id);
                      }
                    } : undefined}
                  >
                    <p>{message.content}</p>
                    <div className="dm-message-meta">
                      <time dateTime={message.created_at}>{message.is_from_me ? "You" : selected.recipient.display_name}</time>
                      {message.is_from_me && (
                        <span
                          className={`dm-receipt ${message.read ? "is-read" : ""}`}
                          aria-label={message.read ? "Read" : "Sent"}
                          title={message.read ? "Read" : "Sent"}
                        >
                          {message.read ? <CheckCheck size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <p className={`dm-typing ${isPeerTyping ? "is-visible" : ""}`} aria-live="polite">
                {isPeerTyping ? `${selected.recipient.display_name} is typing…` : ""}
              </p>
              <form className="dm-composer" onSubmit={sendMessage}>
                <label className="sr-only" htmlFor="dm-message">Write a private message</label>
                <textarea
                  id="dm-message"
                  value={draft}
                  onChange={(event) => handleDraftChange(event.target.value)}
                  placeholder={connection === "ready" ? "Write a private message…" : "Connecting to secure messaging…"}
                  maxLength={2_000}
                  rows={3}
                  disabled={connection !== "ready"}
                />
                <button className="dm-primary-button" type="submit" disabled={isSending || !draft.trim() || connection !== "ready"}>
                  {isSending ? "Sending…" : "Send message"}
                  <Send size={13} aria-hidden="true" />
                </button>
              </form>
            </>
          ) : (
            <div className="dm-empty-state">
              <span className="dm-icon" aria-hidden="true"><MessageSquare size={36} /></span>
              <h3>Choose a conversation</h3>
              <p>Search for a signed-in Aegis user to begin.</p>
            </div>
          )}
        </div>
      </div>
      {notice && <p className="dm-notice" role="status">{notice}</p>}
      {error && <p className="dm-error" role="alert">{error}</p>}
      <p className="dm-footnote">Private messages require an account. Do not share anything that could put you at greater risk if your device is monitored.</p>
    </section>
  );
}
