import { DateTime } from 'luxon';
import { Packument, packument } from 'pacote';
import { maxSatisfying as maxSatisfyingVersion, satisfies as versionSatisfies } from 'semver';
import { Config, Node, Validation } from './types';

const packumentOptions = { fullMetadata: true, preferOnline: true };

function arrayToRegExp(array?: Array<string>): null | RegExp {
  if (array == null) {
    return null;
  }

  return new RegExp(array.map((exclude) => exclude.replace('/*', '\\/.*')).join('|'));
}

export function buildFlatDependencies(tree: Node, config: Config): Map<string, string> {
  let dependencies = new Map<string, string>();

  for (const [name, edge] of tree.edgesOut) {
    if (config.includeDev === true || !edge.dev) {
      dependencies.set(name, edge.spec);
    }
  }

  for (const [, subTree] of tree.children) {
    const subDependencies = buildFlatDependencies(subTree, config);

    dependencies = new Map([...dependencies].concat([...subDependencies]));
  }

  return dependencies;
}

export function processDependencies(dependencies: Map<string, string>, config: Config): Promise<Array<Packument>> {
  const excluded = arrayToRegExp(config.exclude);
  const included = arrayToRegExp(config.include);

  const promises: Array<Promise<Packument>> = [];

  for (const [name, spec] of dependencies) {
    if ((included?.test(name) ?? true) && !(excluded?.test(name) ?? false)) {
      promises.push(packument(`${name}@${spec}`, packumentOptions));
    }
  }

  return Promise.all(promises);
}

export function validateDependencies(
  dependencies: Map<string, string>,
  packuments: Array<Packument>,
  config: Config,
): Map<string, Validation> {
  const now = DateTime.now();

  const validation = new Map<string, Validation>();

  packuments.forEach((packument) => {
    const versions = Object.keys(packument.time ?? {}).filter(
      (version) => version !== 'created' && version !== 'modified',
    );

    const spec = dependencies.get(packument.name) ?? '*';
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
        daysSincePublish: Math.floor(days),
        safe: days >= (config.minDays ?? 30)
      });
    }
  });

  return validation;
}
