import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import honeypotRouter from "./routes/honeypot";

dotenv.config();

const app = express();
app.use(
  cors({
    origin: "*",
    allowedHeaders: ["Content-Type", "x-api-key"],
    methods: ["GET", "POST", "OPTIONS"]
  })
);
app.use(express.json({ limit: "2mb", type: "*/*" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  if (!req.body) req.body = {};
  next();
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
    reply: "OK",
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

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  const apiKey = req.header("x-api-key");
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ status: "error", message: "Invalid API key" });
  }
  return next();
});

app.use("/api", honeypotRouter);

app.get("/health", (req, res) => {
  return res.json({ status: "success" });
});

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
