import { createHmac, timingSafeEqual } from "node:crypto";
import { defineChannel, POST } from "eve/channels";
import { agentcard } from "../lib/agentcard";
import { eveSessionFor, firstTime } from "../lib/store";

// Agentcard delivers webhooks here (POST /agentcard/webhooks). When a user
// finishes the Vault link, the event names the vault session; the store maps
// it back to the iMessage conversation that sent the link, and the agent gets
// a message to relay. Register the endpoint with
// POST /api/v2/webhook_endpoints and store its secret as
// AGENTCARD_WEBHOOK_SECRET.

interface Envelope {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: Record<string, unknown>;
}

/** `AgentCard-Signature: t=<unix>,v1=<hex>`; v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). */
function verify(header: string | null, rawBody: string, secret: string, toleranceSeconds = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds || !parts.v1) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const given = parts.v1;
  return expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

const WEBHOOK_AUTH = {
  authenticator: "agentcard-webhook",
  issuer: "agentcard",
  principalType: "service",
  principalId: "agentcard",
  attributes: {},
} as const;

export default defineChannel({
  routes: [
    POST("/agentcard/webhooks", async (request, { attachSession, waitUntil }) => {
      const secret = process.env.AGENTCARD_WEBHOOK_SECRET;
      if (!secret) return new Response("AGENTCARD_WEBHOOK_SECRET is not set", { status: 500 });

      const raw = await request.text();
      if (!verify(request.headers.get("agentcard-signature"), raw, secret)) {
        return new Response("invalid signature", { status: 401 });
      }

      let event: Envelope;
      try {
        event = JSON.parse(raw) as Envelope;
      } catch {
        return new Response("bad json", { status: 400 });
      }

      // At-least-once delivery: act on each event id once.
      if (!(await firstTime(`evt:${event.id}`))) return new Response("ok");

      const vs = String(event.data.vault_session_id ?? "");
      const sessionId = vs ? await eveSessionFor(vs) : null;
      if (!sessionId) return new Response("ok"); // a link this agent did not send, or one that expired

      // Reply 200 now; the agent turn runs after the response is sent.
      waitUntil(
        (async () => {
          const note = await describe(event);
          if (!note) return;
          // One notice per Vault link. A session_linked notice waits, so a
          // card_stored that follows it claims the slot and names the new card.
          if (note.delayMs) await new Promise((r) => setTimeout(r, note.delayMs));
          if (!(await firstTime(`notified:${vs}`))) return;
          await attachSession(sessionId).send(note.text, { auth: WEBHOOK_AUTH });
        })(),
      );
      return new Response("ok");
    }),
  ],
});

/**
 * The line the agent receives, or null when the event needs no message.
 *
 * Two events can describe one visit. `vault.session_linked` fires the moment
 * the passkey ceremony binds the user; `vault.card_stored` fires when a card
 * lands, in practice 10 to 20 seconds later. A user who only unlocks an
 * existing vault produces the first and never the second, so the first is
 * worth a message; but a user who then stores a new card produces both, and
 * the message should name the new card. So session_linked waits (delayMs)
 * and card_stored, when it comes, claims the notice first.
 */
async function describe(event: Envelope): Promise<{ text: string; delayMs?: number } | null> {
  const d = event.data;
  const vs = String(d.vault_session_id ?? "");
  if (!vs) return null;

  if (event.type === "vault.card_stored") {
    return {
      text:
        `[Agentcard] The user finished the Vault link (session ${vs}). Their ${brand(d.brand)} ending in ${d.last4} is stored ` +
        `and their user_id is ${d.user_id}. Tell them their card is set up and you can shop for them now, in one sentence.`,
    };
  }

  if (event.type === "vault.session_linked") {
    const cards = await agentcard<{ data?: { brand?: string; last4?: string; created_at?: string }[] }>(
      "GET",
      `/api/v2/vault_cards?user_id=${encodeURIComponent(String(d.user_id))}`,
    );
    const list = cards.data ?? [];
    if (list.length === 0) return null; // a new user: vault.card_stored follows with the card
    const c = list.slice().sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0]!;
    return {
      delayMs: 30_000,
      text:
        `[Agentcard] The user finished the Vault link (session ${vs}) by unlocking their existing vault. ` +
        `Their ${brand(c.brand)} ending in ${c.last4} is ready and their user_id is ${d.user_id}. ` +
        `Tell them their card is set up and you can shop for them now, in one sentence.`,
    };
  }

  return null;
}

function brand(value: unknown): string {
  const b = String(value ?? "card").toLowerCase();
  return { visa: "Visa", mastercard: "Mastercard", amex: "Amex", discover: "Discover" }[b] ?? "card";
}
