import { defineTool } from "eve/tools";
import { z } from "zod";
import { agentcard } from "../lib/agentcard";

interface VaultSession {
  id: string;
  url: string;
  user_id: string | null;
  expires_at: string;
  poll_interval: number;
  test_mode: boolean;
}

export default defineTool({
  description:
    "Create an Agentcard Vault session and return the link to text the user. The user opens it, enters their card once, and locks it with a passkey. One link per user per enrollment.",
  inputSchema: z.object({}),
  label: { start: () => "Create a Vault link" },
  async execute() {
    const session = await agentcard<VaultSession>("POST", "/api/v2/vault_sessions", {});
    return {
      id: session.id,
      url: session.url,
      expires_at: session.expires_at,
      test_mode: session.test_mode,
    };
  },
});
