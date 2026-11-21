import { createInterface } from "node:readline";
import { BrowserConnection } from "./engine.mjs";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const connection = new BrowserConnection(send);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  let packet;
  try {
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error("请求过大");
    packet = JSON.parse(line);
    if (
      !packet ||
      typeof packet.id !== "string" ||
      packet.id.length > 80 ||
      !packet.command ||
      typeof packet.command.kind !== "string"
    )
      throw new Error("请求格式不正确");
    const result = await connection.dispatch(packet.command);
    send({ id: packet.id, result });
  } catch (error) {
    send({
      id: packet?.id || "",
      error: {
        code: error.code || "BROWSER_FAILED",
        message: error.message || "浏览器操作失败，请重新核对连接。",
      },
    });
  }
});
input.on("close", () => {
  void connection.disconnect().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void connection.disconnect().finally(() => process.exit(0));
});
