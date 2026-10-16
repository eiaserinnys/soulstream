import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const options = JSON.parse(readFileSync(
  join(dirname(process.env.OPENCODE_CONFIG), "rate-limit-fixture.json"),
  "utf8",
));
const sessionID = "ses_rate_limit_fixture";
if (options.startedPath) writeFileSync(options.startedPath, "started");

if (options.mode === "cancel-before-stdout") {
  process.on("SIGINT", () => {
    writeFileSync(options.signalPath, "SIGINT");
    process.exit(130);
  });
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({
      type: "text",
      sessionID: "ses_cancel_fixture",
      part: { type: "text", text: "cancel fixture response" },
    })}\n`);
  }, 100);
  setInterval(() => {}, 1000);
} else {
  const errorText = `${options.errorType ?? "AI_RetryError"}: Rate limit exceeded; key=FAKE_STDERR_SECRET`;
  const logLine = `level=ERROR message="stream error" small=${options.small} error.error=${JSON.stringify(errorText)}`;

  if (options.mode === "rate-limit") {
    process.on("SIGINT", () => {
      writeFileSync(options.signalPath, "SIGINT");
      process.exit(130);
    });
  }

  if (options.splitChunks) {
    const splitAt = Math.floor(logLine.length / 2);
    process.stderr.write(logLine.slice(0, splitAt));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.stderr.write(`${logLine.slice(splitAt)}\n`);
  } else {
    process.stderr.write(`${logLine}\n`);
  }
  if (options.duplicate) process.stderr.write(`${logLine}\n`);

  if (options.mode === "rate-limit") {
    setTimeout(() => process.exit(0), 5000);
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(`${JSON.stringify({
      type: "text",
      sessionID,
      part: { type: "text", text: "small request completed" },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: "step_finish",
      sessionID,
      part: { type: "step-finish", reason: "stop", cost: 0 },
    })}\n`);
  }
}
