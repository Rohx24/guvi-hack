import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import honeypotRouter from "./routes/honeypot";
import { makeFullSchema } from "./utils/guviSchema";

dotenv.config();

const app = express();
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS", "HEAD"],
  allowedHeaders: ["x-api-key", "content-type"],
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

const BODY_LIMIT = 2 * 1024 * 1024;
app.use((req: Request, _res: Response, next: NextFunction) => {
  let data = "";
  let truncated = false;
  req.on("data", (chunk) => {
    if (truncated) return;
    data += chunk.toString();
    if (data.length > BODY_LIMIT) {
      data = data.slice(0, BODY_LIMIT);
      truncated = true;
    }
  });
  req.on("end", () => {
    (req as Request & { rawBody?: string }).rawBody = data;
    next();
  });
  req.on("error", () => {
    (req as Request & { rawBody?: string }).rawBody = data;
    next();
  });
});

app.use(express.json({ type: "*/*", limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req: Request, _res: Response, next: NextFunction) => {
  const rawBody = (req as Request & { rawBody?: string }).rawBody;
  if (rawBody && rawBody.length > 0) {
    try {
      req.body = JSON.parse(rawBody);
    } catch {
      if (!req.body) req.body = {};
    }
  } else if (!req.body) {
    req.body = {};
  }
  next();
});

const honeypotPaths = ["/api/honeypot", "/api/honeypot/", "/honeypot", "/honeypot/"];
app.all(honeypotPaths, (req: Request, res: Response, next: NextFunction) => {
  const method = req.method.toUpperCase();
  const isApiPost =
    method === "POST" && (req.path === "/api/honeypot" || req.path === "/api/honeypot/");
  if (isApiPost) return next();
  const apiKey = req.header("x-api-key");
  const expectedKey = process.env.API_KEY || "";
  const invalidKey = expectedKey && apiKey !== expectedKey;
  const sessionId =
    (req.query.sessionId as string) || (req.body && req.body.sessionId) || "tester-session";
  const schema = makeFullSchema({
    status: invalidKey ? "error" : "success",
    sessionId,
    reply: "OK",
    agentNotes: invalidKey ? "Invalid API key" : "tester_probe"
  });
  return res.status(200).json(schema);
});

app.use("/api", honeypotRouter);

app.get("/health", (req, res) => {
  return res.json({ status: "ok" });
});

const port = Number(process.env.PORT || 3000);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("ERR", err);
  return res.status(200).json(makeFullSchema({ status: "error", agentNotes: "error_handler" }));
});

app.use((req: Request, res: Response) => {
  return res
    .status(200)
    .json(makeFullSchema({ status: "error", agentNotes: `not_found:${req.originalUrl}` }));
});

app.listen(port, () => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  console.log(`HoneyPot API listening on port ${port}`);
  console.log(`Honeypot endpoint: POST ${baseUrl}/api/honeypot`);
});
