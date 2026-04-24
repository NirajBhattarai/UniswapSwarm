import winston from "winston";

const fmt = winston.format;

export const logger = winston.createLogger({
  level: process.env["LOG_LEVEL"] ?? "info",
  format: fmt.combine(
    fmt.timestamp({ format: "HH:mm:ss" }),
    fmt.colorize(),
    fmt.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
  ),
  transports: [new winston.transports.Console()],
});
