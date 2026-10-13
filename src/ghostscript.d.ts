declare module '@wasm-zoo/ghostscript' {
  export function load(): Promise<{
    exec(args: string[], options: {
      files: Array<{ name: string; data: Uint8Array }>;
      outputs: string[];
      timeoutMs: number;
    }): Promise<{ exitCode: number; files: Array<{ name: string; data: Uint8Array }> }>;
    dispose(): void;
  }>;
}
