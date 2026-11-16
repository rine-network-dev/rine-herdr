// Records every raw line the herdr socket sends for an events.subscribe, as NDJSON on stdout.
// usage: node probe-frames.mjs <socket> <pane_id> <seconds>
import net from "node:net";

const [socketPath, paneId, seconds] = process.argv.slice(2);
const request = {
  id: "probe:subscribe",
  method: "events.subscribe",
  params: {
    subscriptions: [
      { type: "pane.agent_status_changed", pane_id: paneId },
      { type: "pane.closed" },
      { type: "pane.agent_detected" },
      { type: "pane.created" },
    ],
  },
};

const conn = net.createConnection(socketPath, () => conn.write(`${JSON.stringify(request)}\n`));
conn.on("data", (chunk) => process.stdout.write(chunk));
conn.on("error", (err) => {
  process.stderr.write(`socket error: ${err.message}\n`);
  process.exit(1);
});
setTimeout(() => conn.destroy(), Number(seconds) * 1000);
