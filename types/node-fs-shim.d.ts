/** Minimal node typings for the function-hook program, which does not load @types/node. */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:os' {
  export function homedir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}
