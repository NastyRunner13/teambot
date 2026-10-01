import type { ComputerStatus } from '@teambot/shared';

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A running agent computer. `call` hits computerd's API inside it. */
export interface ComputerHandle {
  call<T = unknown>(path: string, body?: Record<string, unknown>, opts?: CallOptions): Promise<T>;
  vnc: { host: string; port: number; password: string };
}

/** How an agent's computer should be built. */
export interface ComputerSpec {
  /** Image to use instead of the default. A stopped computer on another image is rebuilt (its disk is kept). */
  image?: string | null;
  /** Internet access: through this proxy only (firewalled), or open (null). Left out: unchanged. */
  network?: { proxyHost: string; proxyPort: number } | null;
}

export interface ComputerProvider {
  available(): Promise<boolean>;
  imageReady(image?: string): Promise<boolean>;
  status(agentId: string): Promise<ComputerStatus>;
  /** Create/start the agent's computer if needed and wait until it is healthy. */
  ensure(agentId: string, spec?: ComputerSpec): Promise<ComputerHandle>;
  /** Where to reach the VNC server of a computer that is already running (never starts one). */
  vnc(agentId: string): Promise<ComputerHandle['vnc'] | null>;
  /** Whether a request comes from an agent computer (they may not use the TeamBot API). */
  isComputerAddress(ip: string | undefined): boolean;
  /** Kill the commands still running on a computer that is up (never starts one); resolves once they are gone. */
  cancelWork(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  /** Delete the computer and its disk. */
  reset(agentId: string): Promise<void>;
  /** Copy the agent's home folder (/home/agent) out as a tar archive. */
  exportHome(agentId: string, spec?: ComputerSpec): Promise<NodeJS.ReadableStream>;
  /** Put a tar archive made by exportHome back into /home/agent. */
  importHome(agentId: string, tar: NodeJS.ReadableStream, spec?: ComputerSpec): Promise<void>;
}
