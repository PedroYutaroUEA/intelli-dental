import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module';

export interface AgentMetricsReport {
  totalRuns: number;
  insufficientEvidenceRate: number;
  fallbackRate: number;
  averageLatencyMs: number;
  totalTokens: number;
  toolErrorRate: number;
  hallucinationRate: number;
}

@Injectable()
export class AgentMetricsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Aggregated agent metrics. When `clinicId` is provided the report is scoped
   * to that clinic only, preserving tenant isolation for dashboards.
   */
  async report(clinicId?: string): Promise<AgentMetricsReport> {
    const runScope = clinicId ? sql`where clinic_id = ${clinicId}` : sql``;
    const childScope = clinicId
      ? sql`where run_id in (select id from agent_runs where clinic_id = ${clinicId})`
      : sql``;

    const runRows = await this.db.execute<{
      total_runs: string;
      insufficient_runs: string;
      fallback_runs: string;
      avg_latency_ms: string | null;
      total_tokens: string | null;
    }>(sql`
      select
        count(*)::text as total_runs,
        count(*) filter (where insufficient_evidence)::text as insufficient_runs,
        count(*) filter (where fallback_used)::text as fallback_runs,
        avg(total_latency_ms)::text as avg_latency_ms,
        sum(total_tokens_in + total_tokens_out)::text as total_tokens
      from agent_runs
      ${runScope}
    `);
    const runs = runRows.rows[0];

    const toolRows = await this.db.execute<{ total_tools: string; failed_tools: string }>(sql`
      select
        count(*)::text as total_tools,
        count(*) filter (where ok = false)::text as failed_tools
      from tool_calls
      ${childScope}
    `);
    const tools = toolRows.rows[0];

    const verificationRows = await this.db.execute<{ total_verifications: string; failed_verifications: string }>(sql`
      select
        count(*)::text as total_verifications,
        count(*) filter (where kind = 'verification' and faithful = false)::text as failed_verifications
      from agent_evaluations
      ${childScope}
    `);
    const verification = verificationRows.rows[0];

    const totalRuns = Number(runs?.total_runs ?? 0);
    const totalTools = Number(tools?.total_tools ?? 0);
    const totalVerifications = Number(verification?.total_verifications ?? 0);
    return {
      totalRuns,
      insufficientEvidenceRate: ratio(Number(runs?.insufficient_runs ?? 0), totalRuns),
      fallbackRate: ratio(Number(runs?.fallback_runs ?? 0), totalRuns),
      averageLatencyMs: Number(runs?.avg_latency_ms ?? 0),
      totalTokens: Number(runs?.total_tokens ?? 0),
      toolErrorRate: ratio(Number(tools?.failed_tools ?? 0), totalTools),
      hallucinationRate: ratio(Number(verification?.failed_verifications ?? 0), totalVerifications),
    };
  }
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}
