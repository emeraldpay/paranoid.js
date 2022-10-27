export enum ExitCode {
  OK = 0,
  FAIL = 1,
  ERROR = 2,
}

export interface Config {
  allow?: Map<string, string>;
  deny?: Map<string, string>;
  exclude?: string[];
  include?: string[];
  minDays?: number;
  json?: boolean;
  production?: boolean;
  unsafe?: boolean;
  excludeDev?: boolean;
}

interface Edge {
  dev: boolean;
  spec: string;
  to: Node | null;
}

export interface Node {
  children: Map<string, Node>;
  edgesOut: Map<string, Edge>;
  version?: string;
}

export interface Dependency {
  specs: Set<string>;
  versions: Set<string>;
}

export type Dependencies = Map<string, Dependency>;

interface Vulnerability {
  dependency: string;
  range: string | null;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  title: string;
  url: string | null;
}

interface Suggestion {
  fixedVersion: string | null;
}

export type Recommendation = Vulnerability & Suggestion;

export interface Validation {
  daysSincePublish: number;
  recommendations: Recommendation[];
  safe: boolean;
  version: string;
}

export interface Advisory extends Vulnerability {
  versions: string[];
  vulnerableVersions: string[];
  testVersion(version: string): boolean;
}

export type Vulnerabilities = Map<string, Advisory[]>;
