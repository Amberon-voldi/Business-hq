import type { Owner } from "../agents/registry";
import type { TeamMessage } from "../team/messages";

export interface TaskSummary {
  id: string;
  business: string;
  kind: string;
  status: string;
  task: string;
  createdAt: string;
}

/** Everything pushed on the LISTEN WebSocket, one JSON object per frame. */
export type HubEvent =
  | { type: "hello"; owner: Owner; openTasks: number; unreadMessages: number; at: string }
  | { type: "task"; backlog?: boolean; task: TaskSummary }
  | { type: "message"; backlog?: boolean; message: TeamMessage }
  | { type: "pong" };
