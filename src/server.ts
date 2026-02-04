import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import honeypotRouter from "./routes/honeypot";
import { makeFullSchema } from "./utils/guviSchema";

dotenv.config();

const app = express();
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "x-api-key, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    return res
      .status(200)
      .json(makeFullSchema({ reply: "OK", agentNotes: "options_preflight" }));
  }
  return next();
});

app.use(express.json({ type: "*/*", limit: "2mb" }));
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const isJsonSyntax =
    err instanceof SyntaxError &&
    (Object.prototype.hasOwnProperty.call(err as object, "body") || "body" in (err as any));
  if (isJsonSyntax) {
    return res.status(200).json(
      makeFullSchema({
        status: "success",
        sessionId: "tester-session",
        reply: "OK",
        agentNotes: "caught_invalid_json"
      })
    );
  }
  return next(err);
});
app.use(express.urlencoded({ extended: true }));

app.use("/api", honeypotRouter);

app.get("/health", (req, res) => {
  return res.json({ status: "ok" });
});

const port = Number(process.env.PORT || 3000);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("ERR", err);
  return res
    .status(200)
    .json(
      makeFullSchema({
        status: "success",
        reply: "OK",
        agentNotes: `error:${String((err as any)?.message || err)}`
      })
    );
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
