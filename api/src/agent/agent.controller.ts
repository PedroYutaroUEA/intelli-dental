import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ActiveClinic,
  type ClinicContext,
} from '../common/decorators/clinic-context.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ClinicContextGuard } from '../common/guards/clinic-context.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AgentStreamEvent } from './contracts';
import { AgentRequestDto } from './dto/agent-request.dto';
import { AgentService } from './agent.service';
import { toSafeAgentError } from './errors';
import { AgentRateLimitGuard } from './guardrails/rate-limit.guard';

@UseGuards(JwtAuthGuard, ClinicContextGuard)
@Controller({ path: 'chat', version: '1' })
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('sessions/:id/agent')
  @UseGuards(AgentRateLimitGuard)
  async postAgentMessage(
    @ActiveClinic() ctx: ClinicContext,
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgentRequestDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const session = await this.agent.getSession(ctx.clinicId, user.userId, id);
    const origin = req.headers.origin;
    const corsHeaders: Record<string, string> = {};
    if (typeof origin === 'string' && origin.length > 0) {
      corsHeaders['access-control-allow-origin'] = origin;
      corsHeaders['access-control-allow-credentials'] = 'true';
      corsHeaders.vary = 'Origin';
    }

    reply.raw.writeHead(200, {
      ...corsHeaders,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });

    let closed = false;
    const onClientClose = () => {
      closed = true;
      abortController.abort();
    };
    const abortController = new AbortController();
    req.raw.on('close', onClientClose);

    const emit = (ev: AgentStreamEvent) => {
      if (closed) return;
      if (ev.type === 'token') {
        reply.raw.write(`data: ${JSON.stringify(ev.token)}\n\n`);
        return;
      }
      if (ev.type === 'sources') {
        reply.raw.write(`event: sources\ndata: ${JSON.stringify(ev.sources)}\n\n`);
        return;
      }
      if (ev.type === 'metrics') {
        reply.raw.write(`event: metrics\ndata: ${JSON.stringify(ev.metrics)}\n\n`);
        return;
      }
      if (ev.type === 'done') {
        reply.raw.write(`event: done\ndata: ${JSON.stringify({ agentRunId: ev.agentRunId })}\n\n`);
        return;
      }
      reply.raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };

    try {
      const res = await this.agent.run(
        {
          question: dto.question,
          context: {
            clinicId: ctx.clinicId,
            userId: user.userId,
            role: ctx.role,
            sessionId: session.id,
            patientId: session.patientId,
            permissions: ['rag:read', 'appointment:write'],
            locale: 'pt-BR',
          },
          confirm: dto.confirm,
          idempotencyKey: dto.idempotencyKey,
          signal: abortController.signal,
        },
        emit,
      );
      emit({ type: 'done', agentRunId: res.agentRunId });
    } catch (err) {
      const safeError = toSafeAgentError(err);
      emit({
        type: 'error',
        code: safeError.code,
        message: safeError.safeMessage,
      });
    } finally {
      req.raw.off('close', onClientClose);
      reply.raw.end();
    }
  }

}

@UseGuards(JwtAuthGuard, ClinicContextGuard)
@Controller({ path: 'agent', version: '1' })
export class AgentRunsController {
  constructor(private readonly agent: AgentService) {}

  @Get('runs')
  async listAgentRuns(
    @ActiveClinic() ctx: ClinicContext,
    @CurrentUser() user: { userId: string },
    @Query('sessionId') sessionId?: string,
    @Query('patientId') patientId?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const parsedLimit = rawLimit ? Number(rawLimit) : undefined;
    return this.agent.listTraces({
      clinicId: ctx.clinicId,
      userId: user.userId,
      sessionId,
      patientId,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
  }

  @Get('runs/:runId')
  async getAgentRun(
    @ActiveClinic() ctx: ClinicContext,
    @CurrentUser() user: { userId: string },
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    const trace = await this.agent.getTrace(runId, ctx.clinicId, user.userId);
    if (!trace) throw new NotFoundException();
    return trace;
  }

  @Get('metrics')
  async getMetrics(@ActiveClinic() ctx: ClinicContext) {
    return this.agent.getMetrics(ctx.clinicId);
  }
}
