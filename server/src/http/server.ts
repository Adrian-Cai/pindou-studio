import { createServer, type Server } from "node:http";
import type { HttpApplication } from "./app";

export interface RunningHttpServer {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

export async function startHttpServer(
  application: HttpApplication,
  host: string,
  port: number,
): Promise<RunningHttpServer> {
  const server = createServer(application);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法读取 HTTP 监听地址");
  }

  return {
    server,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
