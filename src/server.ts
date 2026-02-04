import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import honeypotRouter from "./routes/honeypot";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb", type: "*/*" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.header("x-api-key");
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ status: "error", message: "Invalid API key" });
  }
  return next();
});

app.use("/api", honeypotRouter);

app.get("/health", (req, res) => {
  return res.json({ status: "ok" });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  console.log(`HoneyPot API listening on port ${port}`);
  console.log(`Honeypot endpoint: POST ${baseUrl}/api/honeypot`);
});
