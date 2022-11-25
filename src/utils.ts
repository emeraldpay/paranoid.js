import { promises as fsPromises } from 'fs';
import { parseSyml } from '@yarnpkg/parsers';
import { DateTime } from 'luxon';
import { Packument, PackumentResult, packument } from 'pacote';
import {
  gt as isGreaterVersion,
  lt as isLessVersion,
  maxSatisfying as maxSatisfyingVersion,
  minVersion,
  subset as rangeSubset,
  validRange,
  satisfies as versionSatisfies,
} from 'semver';
import { ConfigMap, Dependencies, Dependency, Node, Recommendation, Validation, Vulnerabilities } from './types';

const specRegex = /^(@?[^@]+)@([^:]+:)?([^$]+)$/;

function arrayToRegExp(array?: string[]): null | RegExp {
  if (array == null) {
    return null;
  }

  return new RegExp(array.map((exclude) => exclude.replace('/*', '\\/.*')).join('|'));
}

export function mapFromObject<I extends O, O>(
  from: Record<string, I> | undefined,
  transform?: (entry: [string, I]) => [string, O],
): Map<string, O> | undefined {
  if (from == null) {
    return undefined;
  }

  if (transform == null) {
    return new Map(Object.entries(from));
  }

  return new Map(Object.entries(from).map(transform));
}

export function buildFlatDependencies(tree: Node, config: ConfigMap): Dependencies {
  let dependencies = new Map<string, Dependency>();

  for (const [name, edge] of tree.edgesOut) {
    if (config.excludeDev && edge.dev) {
      continue;
    }

    const dependency: Dependency = dependencies.get(name) ?? {
      specs: new Set(),
      versions: new Set(),
    };

    dependency.specs.add(edge.spec);

    if (edge.to?.version != null) {
      dependency.versions.add(edge.to.version);
    }

    dependencies.set(name, dependency);
  }

  for (const [, subTree] of tree.children) {
    const subDependencies = buildFlatDependencies(subTree, config);

    dependencies = new Map([...dependencies].concat([...subDependencies]));
  }

  return dependencies;
}

export async function loadYarnLockfileDependencies(path: string): Promise<Dependencies> {
  const content = await fsPromises.readFile(path);

  const parsed = parseSyml(content.toString());

  const dependencies = new Map<string, Dependency>();

  for (const [key, { version }] of Object.entries(parsed)) {
    if (key === '__metadata') {
      continue;
    }

    const [, name, protocol, spec] = key.match(specRegex) ?? [];

    if (spec == null || validRange(spec) == null) {
      continue;
    }

    if (name != null && (protocol == null || protocol === 'npm:')) {
      const dependency: Dependency = dependencies.get(name) ?? {
        specs: new Set(),
        versions: new Set(),
      };

      dependency.specs.add(spec);
      dependency.versions.add(version);

      dependencies.set(name, dependency);
    }
  }

  return dependencies;
}

export function processDependencies(dependencies: Dependencies, config: ConfigMap): Promise<Packument[]> {
  const excluded = arrayToRegExp(config.exclude);
  const included = arrayToRegExp(config.include);

  const promises: Array<Promise<Packument & PackumentResult>> = [];

  for (const [name, { specs }] of dependencies) {
    if ((included?.test(name) ?? true) && !(excluded?.test(name) ?? false)) {
      const spec = [...specs].reduce((carry, item) => {
        const itemVersion = minVersion(item);
        const carryVersion = minVersion(carry);

        if (itemVersion == null || carryVersion == null) {
          return carry;
        }

        return isGreaterVersion(itemVersion, carryVersion) ? item : carry;
      }, '^0.0.0');

      promises.push(packument(`${name}@${spec}`, { fullMetadata: true, preferOnline: true }));
    }
  }

  return Promise.all(promises);
}

export function validateDependencies(
  dependencies: Dependencies,
  packuments: Packument[],
  vulnerabilities: Vulnerabilities,
  config: ConfigMap,
): Map<string, Validation[]> {
  const minDays = config.minDays ?? 14;
  const now = DateTime.now();

  const validations = new Map<string, Validation[]>();

  packuments.forEach((packument) => {
    const versions = Object.keys(packument.time ?? {}).filter(
      (version) => version !== 'created' && version !== 'modified',
    );

    const dependency = dependencies.get(packument.name);
    const vulnerability = vulnerabilities.get(packument.name);

    let specs: Set<string> = new Set(['*']);

    if (dependency != null) {
      if (config.production && dependency.versions.size > 0) {
        specs = dependency.versions;
      } else {
        specs = new Set(
          [...dependency.specs]
            .sort((first, second) => (rangeSubset(first, second) ? -1 : 1))
            .reduce<string[]>((carry, spec) => {
              if (carry.length === 0) {
                return [spec];
              }

              for (const subset of carry) {
                if (rangeSubset(subset, spec)) {
                  return carry;
                }
              }

              return [...carry, spec];
            }, [])
            .reverse(),
        );
      }
    }

    for (const spec of specs) {
      const version = maxSatisfyingVersion(versions, spec) ?? '0.0.0';

      const allowedSpec = config.allow?.get(packument.name);
      const deniedSpec = config.deny?.get(packument.name);

      const allowedFrom = config.allowFrom?.get(packument.name);

      if (
        (allowedSpec == null || versionSatisfies(version, allowedSpec)) &&
        (deniedSpec == null || versionSatisfies(version, deniedSpec)) &&
        (allowedFrom == null || now.diff(allowedFrom.plus({ days: minDays }), 'days').days >= 0)
      ) {
        const published = packument.time?.[version] ?? now.toISO();
        const { days } = now.diff(DateTime.fromISO(published), 'days');

        const recommendations: Recommendation[] = [];

        if (vulnerability != null) {
          for (const advisory of vulnerability) {
            if (advisory.testVersion(version) ?? false) {
              const fixedVersion = advisory.versions
                .filter((item) => !advisory.vulnerableVersions.includes(item) && isGreaterVersion(item, version))
                .reduce<string | null>(
                  (carry, item) => (carry == null ? item : isLessVersion(item, carry) ? item : carry),
                  null,
                );

              recommendations.push({
                fixedVersion,
                dependency: advisory.dependency,
                range: advisory.range,
                severity: advisory.severity,
                title: advisory.title,
                url: advisory.url,
              });
            }
          }
        }

        const validation = validations.get(packument.name) ?? [];

        validation.push({
          recommendations,
          version,
          daysSincePublish: Math.floor(days),
          safe: days >= minDays,
        });

        validations.set(packument.name, validation);
      }
    }
  });

  return validations;
}
