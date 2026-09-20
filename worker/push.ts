import { buildPushHTTPRequest } from "@pushforge/builder";

export type PushPayload = {
  title: string;
  body: string;
  tag?: string;
  data?: Record<string, string>;
  actions?: { action: string; title: string }[];
};

export type SendResult = "sent" | "gone" | "failed";

export async function sendPush(env: Env, subscriptionJson: string, payload: PushPayload): Promise<SendResult> {
  try {
    const { endpoint, headers, body } = await buildPushHTTPRequest({
      privateJWK: env.VAPID_PRIVATE_KEY,
      subscription: JSON.parse(subscriptionJson),
      message: {
        payload,
        adminContact: env.VAPID_SUBJECT,
        options: { ttl: 3600, urgency: "high", topic: payload.tag },
      },
    });
    const res = await fetch(endpoint, { method: "POST", headers, body });
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) {
      console.error("push failed", res.status, await res.text());
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error("push error", err);
    return "failed";
  }
}
