export enum ExitCode {
  OK = 0,
  FAIL = 1,
  ERROR = 2,
}

export interface Config {
  allow?: Map<string, string>;
  deny?: Map<string, string>;
  exclude?: Array<string>;
  include?: Array<string>;
  excludeDev?: boolean;
  json?: boolean;
  minDays?: number;
  unsafe?: boolean;
}

interface Edge {
  dev: boolean;
  spec: string;
}

export interface Node {
  children: Map<string, Node>;
  edgesOut: Map<string, Edge>;
}

export interface Validation {
  daysSincePublish: number;
  safe: boolean;
  version: string;
}

export type Dependencies = Map<string, Set<string>>;
