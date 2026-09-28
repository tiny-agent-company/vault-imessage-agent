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

      const note = await describe(event);
      if (!note) return new Response("ok");

      const sessionId = await eveSessionFor(String(event.data.vault_session_id ?? ""));
      if (!sessionId) return new Response("ok"); // a link this agent did not send, or one that expired

      // Reply 200 now; the agent turn runs after the response is sent.
      waitUntil(attachSession(sessionId).send(note, { auth: WEBHOOK_AUTH }));
      return new Response("ok");
    }),
  ],
});

/**
 * The line the agent receives, or null when the event needs no message.
 * A new user stores a card and `vault.card_stored` says which. A returning
 * user unlocks an existing vault instead, so only `vault.session_linked`
 * fires; the cards they already hold are read to say the same thing.
 */
async function describe(event: Envelope): Promise<string | null> {
  const d = event.data;
  const vs = String(d.vault_session_id ?? "");
  if (!vs) return null;

  if (event.type === "vault.card_stored") {
    // One notice per vault session, whichever event lands first.
    if (!(await firstTime(`notified:${vs}`))) return null;
    return (
      `[Agentcard] The user finished the Vault link (session ${vs}). Their ${brand(d.brand)} ending in ${d.last4} is stored ` +
      `and their user_id is ${d.user_id}. Tell them their card is set up and you can shop for them now, in one sentence.`
    );
  }

  if (event.type === "vault.session_linked") {
    const cards = await agentcard<{ data?: { brand?: string; last4?: string }[] }>(
      "GET",
      `/api/v2/vault_cards?user_id=${encodeURIComponent(String(d.user_id))}`,
    );
    const list = cards.data ?? [];
    if (list.length === 0) return null; // a new user: vault.card_stored follows with the card
    if (!(await firstTime(`notified:${vs}`))) return null;
    const c = list[0]!;
    return (
      `[Agentcard] The user finished the Vault link (session ${vs}) by unlocking their existing vault. ` +
      `Their ${brand(c.brand)} ending in ${c.last4} is ready and their user_id is ${d.user_id}. ` +
      `Tell them their card is set up and you can shop for them now, in one sentence.`
    );
  }

  return null;
}

function brand(value: unknown): string {
  const b = String(value ?? "card").toLowerCase();
  return { visa: "Visa", mastercard: "Mastercard", amex: "Amex", discover: "Discover" }[b] ?? "card";
}
