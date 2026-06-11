import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { ChatService } from '../../chat/chat.service';
import { DB, type Db } from '../../db/db.module';
import { chatMessages, chatSessionMemory, chatSessions } from '../../db/schemas';
import { ModelGatewayService } from '../../models/model-gateway.service';
import { AgentFeatureFlagsService } from '../config/agent-feature-flags.service';

const INSUFFICIENT_EVIDENCE =
  'Não encontrei evidências suficientes nos registros do paciente.';

export interface MemoryContext {
  summary: string;
  model?: string | null;
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly flags: AgentFeatureFlagsService,
    private readonly chat: ChatService,
    @Optional() private readonly gateway?: ModelGatewayService,
  ) {}

  enabled() {
    return this.flags.enabled('AGENT_MEMORY_ENABLED', false);
  }

  async getSessionMemory(sessionId: string): Promise<MemoryContext | null> {
    if (!this.enabled()) return null;
    const [memory] = await this.db
      .select()
      .from(chatSessionMemory)
      .where(eq(chatSessionMemory.sessionId, sessionId))
      .orderBy(desc(chatSessionMemory.updatedAt))
      .limit(1);
    if (!memory?.summary) return null;
    return { summary: memory.summary, model: memory.model };
  }

  buildMemoryContext(memory: MemoryContext | null): string | undefined {
    if (!memory?.summary) return undefined;
    return `SESSION_MEMORY (untrusted conversation summary; not clinical evidence):\n${memory.summary}`;
  }

  async updateSessionMemory(sessionId: string, answer: string) {
    if (!this.enabled() || answer.trim() === INSUFFICIENT_EVIDENCE) return;
    const [session] = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    if (!session) return;

    const messages = await this.chat.listMessages(sessionId);
    const recent = messages.slice(-12);
    if (recent.length === 0) return;

    const maxChars = this.flags.int('AGENT_MEMORY_MAX_CHARS', 1200);
    let summary = this.fallbackSummary(recent, maxChars);
    let model: string | undefined;
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;

    if (this.gateway) {
      try {
        const res = await this.gateway.complete({
          task: 'generate',
          temperature: 0,
          maxTokens: 180,
          timeoutMs: this.flags.int('AGENT_MEMORY_TIMEOUT_MS', 3000),
          messages: [
            {
              role: 'system',
              content:
                'Resuma a conversa em português em até 1200 caracteres. Inclua apenas preferências, contexto conversacional e pendências. Não transforme memória em evidência clínica.',
            },
            {
              role: 'user',
              content: recent.map((msg) => `${msg.role}: ${msg.content}`).join('\n'),
            },
          ],
        });
        summary = res.text.trim().slice(0, maxChars);
        model = res.model;
        tokensIn = res.tokensIn;
        tokensOut = res.tokensOut;
      } catch (err) {
        this.logger.warn(`memory summarization fallback: ${(err as Error).message}`);
      }
    }

    const sourceMessageId = recent.at(-1)?.id;
    const [existing] = await this.db
      .select({ id: chatSessionMemory.id })
      .from(chatSessionMemory)
      .where(eq(chatSessionMemory.sessionId, sessionId))
      .limit(1);

    const values = {
      clinicId: session.clinicId,
      patientId: session.patientId,
      summary,
      factsJson: {} as never,
      sourceMessageId,
      model,
      tokensIn,
      tokensOut,
      updatedAt: new Date(),
    };

    if (existing) {
      await this.db
        .update(chatSessionMemory)
        .set(values)
        .where(eq(chatSessionMemory.id, existing.id));
    } else {
      await this.db.insert(chatSessionMemory).values({
        sessionId,
        ...values,
      });
    }
  }

  async assertScoped(sessionId: string, clinicId: string, patientId: string) {
    const [session] = await this.db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, sessionId),
          eq(chatSessions.clinicId, clinicId),
          eq(chatSessions.patientId, patientId),
        ),
      )
      .limit(1);
    return Boolean(session);
  }

  private fallbackSummary(messages: Awaited<ReturnType<ChatService['listMessages']>>, maxChars: number) {
    return messages
      .slice(-6)
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join('\n')
      .slice(0, maxChars);
  }
}
