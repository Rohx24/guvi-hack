import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import honeypotRouter from "./routes/honeypot";
import chatRouter from "./routes/chat";
import { safeLog, safeStringify, sanitizeHeaders } from "./utils/logging";

dotenv.config();

const app = express();
const turnResponse = (reply: string) => ({ status: "success", reply });
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "x-api-key, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(200).json(turnResponse("OK"));
  }
  return next();
});

app.use(
  express.json({
    type: "*/*",
    limit: "2mb",
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    }
  })
);
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  const isJsonSyntax =
    err instanceof SyntaxError &&
    (Object.prototype.hasOwnProperty.call(err as object, "body") || "body" in (err as any));
  if (isJsonSyntax) {
    try {
      const headers = sanitizeHeaders(req.headers);
      safeLog(`[INCOMING] headers: ${safeStringify(headers, 2000)}`);
      const rawBody = (err as any).body || (req as Request & { rawBody?: string }).rawBody || "";
      safeLog(`[INCOMING] body: ${safeStringify(rawBody, 2000)}`);
    } catch {
      // swallow logging errors
    }
    const responseJson = turnResponse("OK");
    safeLog(`[OUTGOING] response_json: ${safeStringify(responseJson, 5000)}`);
    safeLog("[OUTGOING] status: 200");
    return res.status(200).json(responseJson);
  }
  return next(err);
});
app.use(express.urlencoded({ extended: true }));

app.use("/api", honeypotRouter);
app.use("/api", chatRouter);

app.get("/health", (req, res) => {
  return res.json({ ok: true });
});

const port = Number(process.env.PORT || 3000);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("ERR", err);
  const responseJson = turnResponse("OK");
  safeLog(`[OUTGOING] response_json: ${safeStringify(responseJson, 5000)}`);
  safeLog("[OUTGOING] status: 200");
  return res.status(200).json(responseJson);
});

app.use((req: Request, res: Response) => {
  const responseJson = turnResponse("OK");
  safeLog(`[OUTGOING] response_json: ${safeStringify(responseJson, 5000)}`);
  safeLog("[OUTGOING] status: 200");
  return res.status(200).json(responseJson);
});

app.listen(port, () => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  console.info(`HoneyPot API listening on port ${port}`);
  console.info(`Honeypot endpoint: POST ${baseUrl}/api/honeypot`);
});
