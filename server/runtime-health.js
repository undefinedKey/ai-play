import { z } from 'zod';

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const runtimeMetadataSchema = {
  mode: z.enum(['demo', 'model', 'dsh-pet']).optional(),
  runtime_version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/).optional(),
  capabilities: z.array(z.string().regex(/^[a-z_]{1,32}$/)).max(12).optional(),
};
export const runtimeHealthSchema = z.object({
  world: z.enum(['connected', 'reconnecting', 'incompatible', 'unknown']),
  host: z.enum(['ready', 'unavailable', 'discovering', 'not_applicable', 'unknown']),
  model: z.enum(['idle', 'requesting', 'ready', 'unavailable', 'unknown']),
  waiting_reason: z.enum(['idle', 'plan_running', 'activity_running', 'waiting_event', 'reconnecting', 'host_unavailable', 'model_unavailable', 'rules_incompatible', 'local_error', 'budget_exhausted', 'owner_paused', 'grant_expired', 'grant_missing', 'revoked', 'room_paused', 'room_full', 'controller_busy', 'processing']),
  last_model_success_at: timestamp.optional(), last_request_at: timestamp.optional(),
  last_host_success_at: timestamp.optional(), last_world_success_at: timestamp.optional(),
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable().optional(),
  counters: z.object({ requests: count, replies: count, retries: count, local_failures: count }).strict().optional(),
  pending_events: count.optional(), dropped_events: count.optional(),
  token_usage: z.object({ input_tokens: count, output_tokens: count, source: z.literal('provider') }).strict().nullable().optional(),
}).strict();

export function runtimeReport(args, now, fail) {
  const metadata = z.object(runtimeMetadataSchema).safeParse(args);
  if (!metadata.success) fail('INVALID_ACTION', '运行器元数据格式无效');
  const result = { ...metadata.data };
  if (result.capabilities) result.capabilities = [...new Set(result.capabilities)];
  if (args.health !== undefined) {
    const health = runtimeHealthSchema.safeParse(args.health);
    if (!health.success) fail('INVALID_ACTION', '连接诊断格式无效，请更新完整 Skill');
    result.health = { ...health.data, received_at: now, stale_after_ms: 30000, source: 'bridge' };
  }
  return result;
}
