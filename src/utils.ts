import { promises as fsPromises } from 'fs';
import { parseSyml } from '@yarnpkg/parsers';
import { DateTime } from 'luxon';
import { Packument, PackumentResult, packument } from 'pacote';
import {
  gt as isGreaterVersion,
  maxSatisfying as maxSatisfyingVersion,
  minVersion,
  validRange,
  satisfies as versionSatisfies,
} from 'semver';
import { Config, Dependencies, Node, Validation } from './types';

const specRegex = /^(@?[^@]+)@([^$]+)$/;

function arrayToRegExp(array?: Array<string>): null | RegExp {
  if (array == null) {
    return null;
  }

  return new RegExp(array.map((exclude) => exclude.replace('/*', '\\/.*')).join('|'));
}

export function buildFlatDependencies(tree: Node, config: Config): Dependencies {
  let dependencies = new Map<string, Set<string>>();

  for (const [name, edge] of tree.edgesOut) {
    if (config.excludeDev && edge.dev) {
      continue;
    }

    const specs = dependencies.get(name);

    dependencies.set(name, specs?.add(edge.spec) ?? new Set([edge.spec]));
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

  const dependencies = new Map<string, Set<string>>();

  for (const [key, { version }] of Object.entries(parsed)) {
    if (key === '__metadata') {
      continue;
    }

    const [, name, spec] = key.match(specRegex) ?? [];

    if (name != null) {
      let currentSpec = spec;

      if (spec == null || validRange(spec) == null) {
        currentSpec = version;
      }

      const specs = dependencies.get(name);

      dependencies.set(name, specs?.add(currentSpec) ?? new Set([currentSpec]));
    }
  }

  return dependencies;
}

export function processDependencies(dependencies: Dependencies, config: Config): Promise<Array<Packument>> {
  const excluded = arrayToRegExp(config.exclude);
  const included = arrayToRegExp(config.include);

  const promises: Array<Promise<Packument & PackumentResult>> = [];

  for (const [name, specs] of dependencies) {
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
  packuments: Array<Packument>,
  config: Config,
): Map<string, Validation> {
  const now = DateTime.now();

  const validation = new Map<string, Validation>();

  packuments.forEach((packument) => {
    const versions = Object.keys(packument.time ?? {}).filter(
      (version) => version !== 'created' && version !== 'modified',
    );

    const specs = dependencies.get(packument.name) ?? new Set(['*']);

    for (const spec of specs) {
      const version = maxSatisfyingVersion(versions, spec) ?? '0.0.0';

      const allowedSpec = config.allow?.get(packument.name);
      const deniedSpec = config.deny?.get(packument.name);

      if (
        (allowedSpec == null || versionSatisfies(version, allowedSpec)) &&
        (deniedSpec == null || versionSatisfies(version, deniedSpec))
      ) {
        const published = packument.time?.[version] ?? now.toISO();
        const { days } = now.diff(DateTime.fromISO(published), 'days');

        validation.set(packument.name, {
          version,
          daysSincePublish: Math.floor(days),
          safe: days >= (config.minDays ?? 14),
        });
      }
    }
  });

  return validation;
}
