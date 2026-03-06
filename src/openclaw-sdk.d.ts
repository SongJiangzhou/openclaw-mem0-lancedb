// Minimal type declarations for OpenClaw Plugin SDK
// In real implementation, these would come from @openclaw/plugin-sdk package

export interface Plugin {
  initialize(context: PluginContext): Promise<void>;
  getTools(): Tool[];
  shutdown?(): Promise<void>;
}

export interface PluginContext {
  config: Record<string, any>;
  logger: Logger;
}

export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

export interface Tool {
  name: string;
  description: string;
  parameters: object;
  handler: (params: any) => Promise<any>;
}
