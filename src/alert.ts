/**
 * Alerting — fire a single webhook on a non-green cycle. Best-effort: a failed
 * alert never changes the cycle outcome, it is only logged. The payload is
 * Slack-compatible (`text`) but also carries structured fields any receiver can
 * use. Wire `ALERT_WEBHOOK_URL` to a Slack/Discord/Opsgenie inbound webhook.
 */

import type { Logger } from './log.ts';
import type { CycleMeta } from '@ardurai/contracts';

export interface AlertPayload {
  cycle: CycleMeta;
  status: 'failed' | 'degraded';
  warnings: string[];
}

export async function sendAlert(
  url: string | null,
  payload: AlertPayload,
  logger: Logger,
): Promise<void> {
  if (!url) return;
  const emoji = payload.status === 'failed' ? '🔴' : '🟡';
  const text =
    `${emoji} ardur-pipeline cycle \`${payload.cycle.id}\` ${payload.status}` +
    (payload.warnings.length ? `\n• ${payload.warnings.slice(0, 8).join('\n• ')}` : '');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...payload }),
    });
    if (!res.ok) {
      logger.warn('alert webhook non-2xx', { status: res.status });
    }
  } catch (e) {
    logger.warn('alert webhook failed', { error: e instanceof Error ? e.message : String(e) });
  }
}
