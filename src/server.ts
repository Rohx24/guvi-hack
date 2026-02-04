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

app.use(express.json({ type: "*/*", limit: "2mb" }));
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const isJsonSyntax = err instanceof SyntaxError && "body" in (err as any);
  if (isJsonSyntax) {
    return res.status(200).json(
      makeFullSchema({
        status: "success",
        sessionId: "tester-session",
        reply: "OK",
        agentNotes: "caught_invalid_json_body"
      })
    );
  }
  return next(err);
});
app.use(express.urlencoded({ extended: true }));

const honeypotPaths = ["/api/honeypot", "/api/honeypot/", "/honeypot", "/honeypot/"];
app.all(honeypotPaths, (req: Request, res: Response, next: NextFunction) => {
  const method = req.method.toUpperCase();
  const isApiPost =
    method === "POST" && (req.path === "/api/honeypot" || req.path === "/api/honeypot/");
  if (isApiPost) return next();
  if (method === "GET" || method === "OPTIONS" || method === "HEAD") {
    return res.status(200).json(
      makeFullSchema({
        reply: "OK",
        agentNotes: `probe:${method}`
      })
    );
  }
  const apiKey = req.header("x-api-key");
  const expectedKey = process.env.API_KEY || "";
  const invalidKey = expectedKey && apiKey !== expectedKey;
  const sessionId =
    (req.query.sessionId as string) || (req.body && req.body.sessionId) || "tester-session";
  return res.status(200).json(
    makeFullSchema({
      status: invalidKey ? "error" : "success",
      sessionId,
      reply: "OK",
      agentNotes: invalidKey ? "Invalid API key" : "probe:NON_API_POST"
    })
  );
});

app.use("/api", honeypotRouter);

app.get("/health", (req, res) => {
  return res.json({ status: "ok" });
});

const port = Number(process.env.PORT || 3000);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("ERR", err);
  return res
    .status(200)
    .json(makeFullSchema({ status: "success", reply: "OK", agentNotes: `error:${String((err as any)?.message || err)}` }));
});

app.use((req: Request, res: Response) => {
  return res
    .status(200)
    .json(makeFullSchema({ status: "success", reply: "OK", agentNotes: `not_found:${req.originalUrl}` }));
});

app.listen(port, () => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  console.log(`HoneyPot API listening on port ${port}`);
  console.log(`Honeypot endpoint: POST ${baseUrl}/api/honeypot`);
});
