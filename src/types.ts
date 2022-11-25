import { DateTime } from 'luxon';

export enum ExitCode {
  OK = 0,
  FAIL = 1,
  ERROR = 2,
}

export type Mode = 'common' | 'extend' | 'strict';

interface Config<S, D = S> {
  allow?: S;
  deny?: S;
  exclude?: string[];
  include?: string[];
  minDays?: number;
  json?: boolean;
  production?: boolean;
  unsafe?: boolean;
  allowFrom?: D;
  excludeDev?: boolean;
  mode?: Mode;
}

export type ConfigObject = Config<Record<string, string>>;
export type ConfigMap = Config<Map<string, string>, Map<string, DateTime>>;

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
