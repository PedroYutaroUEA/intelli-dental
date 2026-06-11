import Fastify from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { ingest } from "./ingest/ingest.js";
import {
  embedTexts,
  evaluateAnswer,
  generateAnswerStream,
  getPromptInfo,
  retrieveForQuestion,
} from "./rag.js";

const app = Fastify({ logger: true });

const MetadataValue = z.union([z.string(), z.number(), z.boolean()]);
const QueryHitBody = z.object({
  id: z.string().min(1),
  document: z.string(),
  metadata: z.record(MetadataValue),
  distance: z.number(),
});

const RetrievedChunkBody = z.object({
  chunkId: z.string().min(1),
  document: z.string(),
  source: z.string(),
  index: z.number().int().nonnegative(),
  distance: z.number(),
  score: z.number(),
  metadata: z.record(MetadataValue),
});

const RetrieveFiltersBody = z
  .object({
    patientId: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    sourceType: z.string().min(1).optional(),
    sourceTypes: z.array(z.enum(["anamnesis", "document", "appointment"])).optional(),
    documentVersion: z.string().min(1).optional(),
    corpusVersion: z.number().int().nonnegative().optional(),
  })
  .optional();

const ChatBody = z.object({
  patientId: z.string().min(1),
  question: z.string().min(1),
  k: z.number().int().positive().optional(),
  rerank: z.boolean().optional(),
  filters: RetrieveFiltersBody,
});

const EmbedBody = z.object({
  texts: z.array(z.string()).min(1),
});

const RetrieveBody = z
  .object({
    patientId: z.string().min(1).optional(),
    question: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    k: z.number().int().positive().optional(),
    rerank: z.boolean().optional(),
    filters: RetrieveFiltersBody,
  })
  .refine((body) => Boolean(body.patientId || body.filters?.patientId), {
    message: "patientId is required",
    path: ["filters", "patientId"],
  })
  .refine((body) => Boolean(body.query || body.question), {
    message: "query is required",
    path: ["query"],
  });

const GenerateBody = z
  .object({
    patientId: z.string().min(1),
    question: z.string().min(1),
    hits: z.array(QueryHitBody).optional(),
    chunks: z.array(RetrievedChunkBody).optional(),
  })
  .refine((body) => Boolean(body.hits || body.chunks), {
    message: "chunks are required",
    path: ["chunks"],
  });

const EvaluateBody = z
  .object({
    question: z.string().min(1),
    answer: z.string().optional(),
    hits: z.array(QueryHitBody).optional(),
    chunks: z.array(RetrievedChunkBody).optional(),
  })
  .refine((body) => Boolean(body.hits || body.chunks), {
    message: "chunks are required",
    path: ["chunks"],
  });

const IngestBody = z.object({
  patientId: z.string().min(1),
  dir: z.string().optional(),
  file: z.string().optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        mime: z.string().optional(),
      }),
    )
    .optional(),
});

app.get("/v1/health", async () => ({
  ok: true,
  ollama: config.ollamaUrl,
  chroma: config.chromaUrl,
  model: config.llmModel,
  ...getPromptInfo(),
}));

app.post("/v1/ingest", async (req, reply) => {
  const parsed = IngestBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const payload = parsed.data;
  let result: { docs: number; chunks: number };

  if (payload.dir) {
    result = await ingest({
      patient: payload.patientId,
      dir: payload.dir,
    });
  } else {
    const filePaths = payload.files?.map((f) => f.path) ?? (payload.file ? [payload.file] : []);
    if (filePaths.length === 0) {
      return reply.code(400).send({
        error: "Provide dir, file, or files[].path",
      });
    }

    let docs = 0;
    let chunks = 0;
    for (const filePath of filePaths) {
      const partial = await ingest({
        patient: payload.patientId,
        file: filePath,
      });
      docs += partial.docs;
      chunks += partial.chunks;
    }
    result = { docs, chunks };
  }

  return result;
});

app.post("/v1/embed", async (req, reply) => {
  const parsed = EmbedBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  return embedTexts(parsed.data.texts);
});

app.post("/v1/retrieve", async (req, reply) => {
  const parsed = RetrieveBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  return retrieveForQuestion(parsed.data);
});

app.post("/v1/generate", async (req, reply) => {
  const parsed = GenerateBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  try {
    for await (const piece of generateAnswerStream(parsed.data)) {
      reply.raw.write(`data: ${JSON.stringify(piece)}\n\n`);
    }
    reply.raw.write("event: done\ndata: {}\n\n");
  } catch (err) {
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
  } finally {
    reply.raw.end();
  }
});

app.post("/v1/evaluate", async (req, reply) => {
  const parsed = EvaluateBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const hits =
    parsed.data.hits ??
    parsed.data.chunks?.map((chunk) => ({
      id: chunk.chunkId,
      document: chunk.document,
      distance: chunk.distance,
      metadata: { ...chunk.metadata, source: chunk.source, chunkIndex: chunk.index },
    })) ??
    [];
  return evaluateAnswer({ ...parsed.data, hits });
});

/**
 * POST /chat — streams the answer as Server-Sent Events.
 * Each event has `data: <token>`; a final `event: done` event closes.
 */
app.post("/v1/chat", async (req, reply) => {
  const parsed = ChatBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const { patientId, question } = parsed.data;
  const { hits, sources } = await retrieveForQuestion(parsed.data);
  reply.raw.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);

  let answer = "";
  try {
    for await (const piece of generateAnswerStream({ patientId, question, hits })) {
      answer += piece;
      reply.raw.write(`data: ${JSON.stringify(piece)}\n\n`);
    }

    // Evaluate the RAG-Triad on the completed answer. Failures here must
    // not break the response — we still emit `done` so the client closes.
    try {
      const metrics = await evaluateAnswer({ question, answer, hits });
      reply.raw.write(`event: metrics\ndata: ${JSON.stringify(metrics)}\n\n`);
    } catch (err) {
      app.log.warn({ err }, "metrics evaluation failed");
    }

    reply.raw.write("event: done\ndata: {}\n\n");
  } catch (err) {
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
  } finally {
    reply.raw.end();
  }
});

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
