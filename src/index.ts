#!/usr/bin/env node

import { existsSync, statSync as pathStat } from 'fs';
import { resolve as resolvePath } from 'path';
import * as process from 'process';
import * as Arborist from '@npmcli/arborist';
import * as Calculator from '@npmcli/metavuln-calculator';
import { Command, Option } from 'commander';
import { Validator } from 'jsonschema';
import { DateTime } from 'luxon';
import * as fetch from 'npm-registry-fetch';
import { Packument } from 'pacote';
import { validRange } from 'semver';
import { createLogger, format as loggerFormat, transports as loggerTransports } from 'winston';
import { Advisory, ConfigMap, ConfigObject, Dependency, ExitCode, Node, Validation } from './types';
import {
  buildFlatDependencies,
  loadYarnLockfileDependencies,
  mapFromObject,
  processDependencies,
  validateDependencies,
} from './utils';
/* eslint-disable @typescript-eslint/no-var-requires */
const { version } = require('../package.json');
const schema = require('../schema.json');
/* eslint-enable @typescript-eslint/no-var-requires */

const program = new Command();

program
  .argument('<path>', 'path to project directory')
  .version(version)
  .option('-c, --config <path>', 'use specified path to config file')
  .option('-a, --allow <allow>', 'comma separated list of allowed packages with version spec (<package>@<spec>)')
  .option('-d, --deny <deny>', 'comma separated list of denied packages with version spec (<package>@<spec>)')
  .option('-e, --exclude <exclude>', 'comma separated list of exclude packages from validating')
  .option('-i, --include <include>', 'comma separated list of include packages from validating')
  .option('-m, --minDays <days>', 'minimum days after publish (default 14)')
  .option('-j, --json', 'display output as JSON')
  .option('-p, --production', 'if it possible, then check specified version from lock file')
  .option('-u, --unsafe', 'return only unsafe packages')
  .option('--debug', 'show debug messages')
  .option('--allowFrom <allow>', 'comma separated list of allowed packages with install date (<package>:<date>)')
  .option('--excludeDev', 'exclude development dependencies for validation (ignored for Yarn projects only)')
  .option('--ignoreConfig', 'ignore config file, even if used specified path')
  .option('--ignoreOptions <options>', 'comma separated list of options to ignore from config file')
  .addOption(new Option('--mode <mode>', 'validation mode').choices(['common', 'extend', 'strict']))
  .parse();

const [path] = program.args;
const options = program.opts();

const logger = createLogger({
  format: loggerFormat.combine(loggerFormat.colorize(), loggerFormat.simple()),
  level: options.debug ? 'debug' : 'info',
  transports: [new loggerTransports.Console()],
});

(async () => {
  let config: ConfigMap = {};

  if (options.ignoreConfig == null) {
    let configPath: string | undefined;

    if (options.config == null) {
      const projectConfigPath = resolvePath(path, '.paranoidrc.js');

      if (existsSync(projectConfigPath)) {
        configPath = projectConfigPath;
      }
    } else {
      const optionConfigPath = resolvePath(options.config);

      if (existsSync(optionConfigPath) && pathStat(optionConfigPath).isFile()) {
        configPath = optionConfigPath;
      } else {
        logger.error('Cannot find specified config file');

        process.exit(ExitCode.ERROR);
      }
    }

    if (configPath != null) {
      try {
        const configData: ConfigObject = await import(configPath);

        const allowFrom =
          configData.allowFrom == null
            ? undefined
            : mapFromObject(configData.allowFrom, ([name, date]) => [name, DateTime.fromISO(date)]);

        config = {
          allowFrom,
          allow: mapFromObject(configData.allow),
          deny: mapFromObject(configData.deny),
          exclude: configData.exclude,
          include: configData.include,
          minDays: configData.minDays,
          json: configData.json,
          production: configData.production,
          unsafe: configData.unsafe,
          excludeDev: configData.excludeDev,
          mode: configData.mode,
        };

        const validator = new Validator();

        if (!validator.validate(config, schema)) {
          logger.error('Invalid schema of config file');

          process.exit(ExitCode.ERROR);
        }
      } catch (exception) {
        logger.error('Cannot read config file');
        logger.debug(exception);

        process.exit(ExitCode.ERROR);
      }
    }

    if (options.ignoreOptions != null) {
      const ignoredOptions: string[] = options.ignoreOptions.split(',').map((option: string) => option.trim());

      if (ignoredOptions.length > 0) {
        config = Object.keys(config).reduce<ConfigMap>((carry, option) => {
          if (ignoredOptions.includes(option)) {
            return carry;
          }

          return {
            ...carry,
            [option]: config[option as keyof ConfigMap],
          };
        }, {});
      }
    }
  }

  if (options.allow != null) {
    config.allow = new Map(
      options.allow
        .trim()
        .split(',')
        .map((allow: string) =>
          allow
            .trim()
            .split('@')
            .map((item: string) => item.trim())
            .filter(([, spec]) => validRange(spec) != null),
        ),
    );
  }

  if (options.deny != null) {
    config.deny = new Map(
      options.deny
        .trim()
        .split(',')
        .map((deny: string) =>
          deny
            .trim()
            .split('@')
            .map((item: string) => item.trim())
            .filter(([, spec]) => validRange(spec) != null),
        ),
    );
  }

  if (options.exclude != null) {
    config.exclude = options.exclude
      .trim()
      .split(',')
      .map((exclude: string) => exclude.trim());
  }

  if (options.include != null) {
    config.include = options.include
      .trim()
      .split(',')
      .map((include: string) => include.trim());
  }

  if (options.minDays != null) {
    const days = parseInt(options.minDays, 10);

    config.minDays = isNaN(days) ? undefined : Math.min(1, days);
  }

  if (options.json != null) {
    config.json = true;
  }

  if (options.production != null) {
    config.production = true;
  }

  if (options.unsafe != null) {
    config.unsafe = true;
  }

  if (options.allowFrom != null) {
    config.allowFrom = new Map(
      options.allowFrom
        .trim()
        .split(',')
        .map((allow: string) =>
          allow
            .trim()
            .split(':')
            .map((item: string) => item.trim())
            .filter(([, date]) => DateTime.fromISO(date).isValid),
        ),
    );
  }

  if (options.excludeDev != null) {
    config.excludeDev = true;
  }

  config.mode = options.mode ?? config.mode ?? 'common';

  const yarnLockfilePath = resolvePath(path, 'yarn.lock');

  const hasNpmLockfile = existsSync(resolvePath(path, 'package-lock.json'));
  const hasNodeModules = existsSync(resolvePath(path, 'node_modules'));
  const hasYarnLockfile = existsSync(yarnLockfilePath);

  !(config.json ?? false) && logger.info('Start loading dependency list...');

  let dependencies: Map<string, Dependency>;

  if (hasNpmLockfile || (hasNodeModules && !hasYarnLockfile)) {
    const arborist = new Arborist({ path });

    let tree: Node;

    if (hasNpmLockfile) {
      tree = await arborist.loadVirtual();
    } else {
      tree = await arborist.loadActual();
    }

    dependencies = buildFlatDependencies(tree, config);
  } else if (hasYarnLockfile) {
    dependencies = await loadYarnLockfileDependencies(yarnLockfilePath);
  } else {
    logger.error('Cannot find "package-lock.json" file or "node_modules" folder in specified directory');

    process.exit(ExitCode.ERROR);
  }

  !(config.json ?? false) && logger.info('Retrieving packages metadata...');

  let packuments: Packument[];

  try {
    packuments = await processDependencies(dependencies, config);
  } catch (exception) {
    logger.error(`Error while retrieving packages metadata: ${(exception as Error).message}`);
    logger.debug(exception);

    process.exit(ExitCode.ERROR);
  }

  !(config.json ?? false) && logger.info('Validate dependencies...');

  const vulnerabilities = new Map<string, Advisory[]>();

  if (config.mode !== 'common') {
    try {
      const request = await fetch('/-/npm/v1/security/advisories/bulk', {
        body: Object.fromEntries(
          [...dependencies].reduce<Array<[string, Array<string>]>>(
            (carry, [name, { versions }]) => [...carry, [name, [...versions]]],
            [],
          ),
        ),
        gzip: true,
        method: 'POST',
      });

      const advisories: Record<string, unknown[]> = await request.json();

      const calculator = new Calculator();

      for (const [name, items] of Object.entries(advisories)) {
        for (const item of items) {
          const advisory = await calculator.calculate(name, item);

          const vulnerability = vulnerabilities.get(name) ?? [];

          vulnerability.push(advisory);

          vulnerabilities.set(name, vulnerability);
        }
      }
    } catch (exception) {
      logger.warn(`Cannot get security advisories: ${(exception as Error).message}`);
      logger.debug(exception);
    }
  }

  const validations = validateDependencies(dependencies, packuments, vulnerabilities, config);

  let fullSafe = true;

  if (config.json === true) {
    const data: Record<string, Validation[]> = {};

    for (const [name, items] of validations) {
      data[name] = config.unsafe === true ? items.filter((validation) => !validation.safe) : items;

      fullSafe &&= items.reduce((carry, validation) => carry && validation.safe, true);
    }

    console.log(JSON.stringify(data));
  } else {
    if (config.mode === 'extend') {
      const severities: Map<string, number> = new Map();

      validations.forEach((items) =>
        items.forEach(({ recommendations }) =>
          recommendations.forEach(({ severity }) => {
            const count = severities.get(severity);

            severities.set(severity, (count ?? 0) + 1);
          }),
        ),
      );

      if (severities.size > 0) {
        logger.warn(
          `Some dependencies have security advisers with following severities: ${[...severities]
            .reduce<string[]>((carry, [severity, count]) => [...carry, `${count} ${severity}`], [])
            .join(', ')}. Run with 'strict' mode for more information.`,
        );
      }
    }

    for (const [name, items] of validations) {
      for (const { daysSincePublish, recommendations, safe, version } of items) {
        if (config.mode === 'strict' && recommendations.length > 0) {
          logger.warn(`Package ${name}@${version} is not safe:`);

          for (const [index, { dependency, fixedVersion, range, severity, title, url }] of recommendations.entries()) {
            if (recommendations.length > 1) {
              logger.warn(`\t-- ${index + 1} of ${recommendations.length} --`);
            }

            if (dependency !== name) {
              logger.warn(`\tDependency "${dependency}" is vulnerable`);
            }

            logger.warn(`\tDescription: ${title}`);
            logger.warn(`\tHas a ${severity} severity, check ${url} for more details`);
            logger.warn(`\tVersions ${range} is affected, install version ${fixedVersion}`);
          }
        } else if (safe) {
          if (config.unsafe !== true) {
            logger.info(`Package ${name}@${version} is safe`);
          }
        } else {
          logger.warn(`Package ${name}@${version} is not safe (${daysSincePublish} day(s) since last publish)`);
        }

        fullSafe &&= safe;
      }
    }
  }

  if (!(config.json ?? false) && fullSafe) {
    logger.info('All packages are safe!');
  }

  process.exit(fullSafe ? ExitCode.OK : ExitCode.FAIL);
})();
