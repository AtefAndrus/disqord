/**
 * GitHub Webhook release event payload
 * @see https://docs.github.com/en/webhooks/webhook-events-and-payloads#release
 */
export interface GitHubReleasePayload {
  action:
    | "published"
    | "unpublished"
    | "created"
    | "edited"
    | "deleted"
    | "prereleased"
    | "released";
  release: {
    id: number;
    tag_name: string;
    name: string | null;
    body: string | null;
    html_url: string;
    prerelease: boolean;
    draft: boolean;
    created_at: string;
    published_at: string | null;
    author: {
      login: string;
      avatar_url: string;
    };
  };
  repository: {
    id: number;
    name: string;
    full_name: string;
    html_url: string;
  };
  sender: {
    login: string;
    avatar_url: string;
  };
}

export interface NotificationResult {
  success: number;
  failed: number;
  skipped: number;
  errors: Array<{
    guildId: string;
    channelId: string;
    error: string;
  }>;
}
