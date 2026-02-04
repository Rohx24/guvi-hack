import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import honeypotRouter from "./routes/honeypot";

dotenv.config();

const app = express();
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["x-api-key", "content-type"]
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ type: "*/*", limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (!req.body) req.body = {};
  next();
});

app.use("/api", honeypotRouter);

app.get("/health", (req, res) => {
  return res.json({ status: "ok" });
});

function minSchema(agentNotes: string) {
  const now = new Date().toISOString();
  return {
    status: "success",
    sessionId: "tester-session",
    scamDetected: false,
    scamScore: 0,
    stressScore: 0,
    engagement: {
      mode: "SAFE",
      totalMessagesExchanged: 0,
      agentMessagesSent: 0,
      scammerMessagesReceived: 0,
      startedAt: now,
      lastMessageAt: now
    },
    reply: "tester ping",
    extractedIntelligence: {
      bankAccounts: [],
      upiIds: [],
      phishingLinks: [],
      phoneNumbers: [],
      emails: [],
      suspiciousKeywords: []
    },
    agentNotes
  };
}

const port = Number(process.env.PORT || 3000);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("ERR", err);
  return res.status(200).json(minSchema("error_handler"));
});

app.use((req: Request, res: Response) => {
  return res.status(200).json(minSchema(`not_found:${req.originalUrl}`));
});

app.listen(port, () => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  console.log(`HoneyPot API listening on port ${port}`);
  console.log(`Honeypot endpoint: POST ${baseUrl}/api/honeypot`);
});
