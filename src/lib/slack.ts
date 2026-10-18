import { clip } from "../notion/blocks";

const SLACK_TEXT_LIMIT = 3500;

export interface SlackReply {
  text: string;
  responseUrl?: string | undefined;
  channel?: string | undefined;
  threadTs?: string | undefined;
}

/** Replies via a slash-command response_url, or chat.postMessage when a bot token is configured. */
export async function postSlackReply(botToken: string | undefined, reply: SlackReply): Promise<void> {
  const text =
    reply.text.length > SLACK_TEXT_LIMIT
      ? `${reply.text.slice(0, SLACK_TEXT_LIMIT)}\n…_(truncated — full output is in Notion)_`
      : reply.text;

  if (reply.responseUrl) {
    const res = await fetch(reply.responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", replace_original: false, text }),
    });
    if (!res.ok) throw new Error(`Slack response_url returned ${res.status}`);
    return;
  }

  if (reply.channel && botToken) {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${botToken}` },
      body: JSON.stringify({ channel: reply.channel, thread_ts: reply.threadTs, text }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !body.ok) throw new Error(`Slack chat.postMessage failed: ${body.error ?? res.status}`);
  }
}

export function slackSummary(owner: string, summary: string, output: string, warnings: string[]): string {
  const warn = warnings.length ? `\n:warning: ${warnings.join("\n:warning: ")}` : "";
  return `*${owner}* — ${clip(summary, 300)}${warn}\n\n${output}`;
}
